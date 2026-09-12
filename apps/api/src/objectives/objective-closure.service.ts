import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  DEFAULT_CLOSURE_SIGN_OFF_POLICY,
  decideClosure,
  mayTransitionObjective,
  MIN_OUTCOME_EXPLANATION_LENGTH,
  OBJECTIVE_STATUS_LABELS,
  PAUSE_EFFECT,
  PAUSE_REASONS,
  readinessForReview,
  slaOutcome,
  verdictRequiresExplanation,
  type ClosureSignOffPolicy,
  type ObjectiveStatus,
  type OutcomeComparison,
  type OutcomeVerdict,
  type PauseReason,
  type ReadinessForReview,
  type SlaOutcome,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { CompanySettingsService } from '../settings/company-settings.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** One pause, as a screen shows it. */
export interface ObjectivePauseView {
  id: string;
  reasonKind: PauseReason;
  reason: string;
  pausedByUserId: string;
  pausedAt: string;
  resumedByUserId: string | null;
  resumedAt: string | null;
  resumeNote: string | null;
  /** Whole days the objective spent stopped. Null while it is still paused. */
  daysStopped: number | null;
}

/** The review, as a screen shows it. */
export interface OutcomeReviewView {
  id: string;
  objectiveId: string;
  objectiveVersionId: string;
  verdict: OutcomeVerdict;
  actualResult: string;
  explanation: string | null;
  slaOutcome: SlaOutcome;
  daysLate: number | null;
  comparison: OutcomeComparison;
  signOffPolicy: ClosureSignOffPolicy;
  reviewedByUserId: string;
  reviewedAt: string;
  signedOffByUserId: string | null;
  signedOffAt: string | null;
  approvalRequestId: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
}

/**
 * Objective closure — Prompt 34.
 *
 * ## Why this is its own service
 *
 * `ObjectiveService` is 1,900 lines about authoring: the Form 2 content, the review routing, the
 * approval and the versioning. Closure is a different subject with its own two tables, and the
 * only thing the two share is the version's status column — which is governed by one transition
 * table they both read. Putting closure inside the authoring service would have added a third
 * concern to a file that already holds two.
 *
 * ## The review compares; it does not measure
 *
 * Every figure comes from the module that owns it — Form 2 for the expected result and the target,
 * `human_tasks` for effort, the Prompt 30 ledger for AI cost, `executor_exceptions` for unresolved
 * items — and is **snapshotted** into the review at the moment it is written. A review read live
 * would change after it was signed, and §27.1 asks for a formal closure.
 *
 * ## What pause does not do
 *
 * It stops new work and nothing else. Runs in flight finish, because killing one would lose what
 * it had done and a pause is meant to be reversible. The definition stays frozen, so rethinking a
 * paused objective means a new Draft version — `FROZEN_OBJECTIVE_STATUSES` includes `Paused`, and
 * so does the database trigger that enforces it.
 */
@Injectable()
export class ObjectiveClosureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly settings: CompanySettingsService,
  ) {}

  /** What the screens need: the reasons, what a pause does, and the company's closure policy. */
  async meta(input: { scope: TenantScope; actorUserId: string }): Promise<Record<string, unknown>> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    return {
      pauseReasons: [...PAUSE_REASONS],
      pauseEffect: PAUSE_EFFECT,
      signOffPolicy: await this.signOffPolicy(input.scope),
      minExplanationLength: MIN_OUTCOME_EXPLANATION_LENGTH,
      note:
        'An objective is closed by reviewing it, not by archiving it. Reopening the work is a new ' +
        'Draft version under the versioning rule — the version that was executed is never ' +
        'rewritten.',
    };
  }

  // -------------------------------------------------------------------------
  // Pause and resume
  // -------------------------------------------------------------------------

  /**
   * Pause a live objective.
   *
   * `objective:Publish` — the grant that put the objective live, and the one `complete` and
   * `archive` also use. Authority over live work is one authority.
   *
   * **Not `objective:Pause`**, which would have been the obvious reading and is a route nobody
   * could call: `Pause` is in the closed `ACTIONS` set but the role templates grant it on
   * `agents` only. A test now pins that every action this module gates on is actually held by
   * some role, because this is the second prompt running to hit it.
   *
   * A `Head` holds `Publish` on `objective`; a `Manager` and an `Employee` do not, because
   * stopping a company's work is not an individual contributor's call.
   */
  async pause(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    reasonKind: PauseReason;
    reason: string;
  }): Promise<ObjectivePauseView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Publish' });

    if (input.reason.trim().length < 4) {
      throw new BadRequestException(
        'Say why the objective is being paused. People are working to it, and an unexplained ' +
          'stop is the thing they will ask about.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const live = await this.liveVersion(input.scope, input.objectiveId);

      if (!mayTransitionObjective(live.status as ObjectiveStatus, 'Paused')) {
        throw new ConflictException(
          `A version that is ${OBJECTIVE_STATUS_LABELS[live.status as ObjectiveStatus]} cannot ` +
            'be paused. Only live work can be stopped.',
        );
      }

      const open = await this.prisma.client.objectivePause.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          objectiveId: input.objectiveId,
          resumedAt: null,
        },
      });
      if (open !== null) {
        throw new ConflictException('That objective is already paused.');
      }

      const created = await this.prisma.client.objectivePause.create({
        data: {
          tenantId: input.scope.tenantId,
          objectiveId: input.objectiveId,
          reasonKind: input.reasonKind,
          reason: input.reason,
          pausedByUserId: input.actorUserId,
        },
      });

      await this.prisma.client.objectiveVersion.update({
        where: { id: live.id },
        data: { status: 'Paused', version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.paused',
        resourceType: 'objective',
        resourceId: input.objectiveId,
        actorUserId: input.actorUserId,
        summary: `Paused: ${input.reason}`,
        metadata: {
          reasonKind: input.reasonKind,
          reason: input.reason,
          versionId: live.id,
          versionNumber: live.versionNumber,
        },
      });

      return ObjectiveClosureService.pauseView(created);
    });
  }

  /** Resume a paused objective. The same grant: whoever may stop it may start it again. */
  async resume(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    note?: string;
  }): Promise<ObjectivePauseView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Publish' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const version = await this.versionInStatus(input.scope, input.objectiveId, 'Paused');

      const open = await this.prisma.client.objectivePause.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          objectiveId: input.objectiveId,
          resumedAt: null,
        },
      });
      if (open === null) {
        throw new ConflictException(
          'That objective has no open pause. Its version says paused and no pause record is ' +
            'open, which should not happen — the two are written in one transaction.',
        );
      }

      const resumed = await this.prisma.client.objectivePause.update({
        where: { id: open.id },
        data: {
          resumedAt: new Date(),
          resumedByUserId: input.actorUserId,
          ...(input.note === undefined || input.note.trim() === ''
            ? {}
            : { resumeNote: input.note.trim() }),
          version: { increment: 1 },
        },
      });

      await this.prisma.client.objectiveVersion.update({
        where: { id: version.id },
        data: { status: 'Active', version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.resumed',
        resourceType: 'objective',
        resourceId: input.objectiveId,
        actorUserId: input.actorUserId,
        summary:
          `Resumed after ${ObjectiveClosureService.daysBetween(open.pausedAt, new Date())} ` +
          `day(s) stopped.${input.note === undefined ? '' : ` ${input.note}`}`,
        metadata: {
          pauseId: open.id,
          reasonKind: open.reasonKind,
          daysStopped: ObjectiveClosureService.daysBetween(open.pausedAt, new Date()),
        },
      });

      return ObjectiveClosureService.pauseView(resumed);
    });
  }

  /** Every pause this objective has had. The history is the point of the table. */
  async pauses(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<ObjectivePauseView[]> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const rows = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.objectivePause.findMany({
        where: { tenantId: input.scope.tenantId, objectiveId: input.objectiveId },
        orderBy: [{ pausedAt: 'desc' }],
      }),
    );

    return rows.map((row) => ObjectiveClosureService.pauseView(row));
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  /**
   * Mark a live objective complete.
   *
   * `objective:Publish` — the same authority that made it live. Declaring a company's work
   * finished is the same weight of decision as declaring it started, and `Manager` and `Head`
   * hold `Publish` on `objective` while an `Employee` does not.
   *
   * A paused objective cannot be completed: the transition table has no such edge, so finishing
   * work that is currently stopped means resuming it first. That prevents closing an objective
   * whose remaining work was never restarted.
   */
  async complete(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<{ status: ObjectiveStatus; readiness: ReadinessForReview }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Publish' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const live = await this.liveVersion(input.scope, input.objectiveId);

      if (!mayTransitionObjective(live.status as ObjectiveStatus, 'Completed')) {
        throw new ConflictException(
          `A version that is ${OBJECTIVE_STATUS_LABELS[live.status as ObjectiveStatus]} cannot ` +
            'be completed. A paused objective has to be resumed first, so nobody finishes work ' +
            'that was never restarted.',
        );
      }

      const updated = await this.prisma.client.objectiveVersion.update({
        where: { id: live.id },
        data: { status: 'Completed', version: { increment: 1 } },
      });

      const comparison = await this.compare(input.scope, input.objectiveId, updated.id);

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.completed',
        resourceType: 'objective',
        resourceId: input.objectiveId,
        actorUserId: input.actorUserId,
        resourceVersion: updated.version,
        summary: `V${live.versionNumber} completed.`,
        metadata: {
          versionId: live.id,
          versionNumber: live.versionNumber,
          humanTasksCompleted: comparison.humanTasksCompleted,
          humanTasksTotal: comparison.humanTasksTotal,
          exceptionsUnresolved: comparison.exceptionsUnresolved,
        },
      });

      return { status: 'Completed', readiness: readinessForReview(comparison) };
    });
  }

  // -------------------------------------------------------------------------
  // Outcome Review
  // -------------------------------------------------------------------------

  /**
   * The comparison, live, before a review is written.
   *
   * Offered separately so the screen can show an operator what they are about to sign, and so the
   * readiness reasons are visible before they press anything.
   */
  async readiness(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<{ comparison: OutcomeComparison; readiness: ReadinessForReview }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const version = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.objectiveVersion.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          objectiveId: input.objectiveId,
          status: { in: ['Completed', 'OutcomeReview', 'Closed'] },
        },
        orderBy: [{ versionNumber: 'desc' }],
      }),
    );

    if (version === null) {
      throw new NotFoundException(
        'That objective has no completed version, so there is nothing to review yet.',
      );
    }

    const comparison = await this.compare(input.scope, input.objectiveId, version.id);
    return { comparison, readiness: readinessForReview(comparison) };
  }

  /**
   * Write the Outcome Review.
   *
   * `objective:Approve` — reviewing how work turned out is a judgement rather than an edit, and
   * `Head` and `Approver` hold it. Deliberately **not** `Publish`: the person who declared the
   * work finished should not be the only one who can grade it, and a company that wants those to
   * be the same person assigns both.
   *
   * The review moves the version to `OutcomeReview` and does **not** close it. Closure is a
   * separate act because the sign-off policy may require somebody else.
   */
  async review(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    verdict: OutcomeVerdict;
    actualResult: string;
    explanation?: string;
  }): Promise<OutcomeReviewView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Approve' });

    const problems: string[] = [];
    if (input.actualResult.trim().length < 10) {
      problems.push(
        'Say what actually happened. It is the one thing in the review that is recorded nowhere ' +
          'else in UBoss.',
      );
    }
    if (
      verdictRequiresExplanation(input.verdict) &&
      (input.explanation ?? '').trim().length < MIN_OUTCOME_EXPLANATION_LENGTH
    ) {
      problems.push(
        `A "${input.verdict}" verdict needs at least ${MIN_OUTCOME_EXPLANATION_LENGTH} ` +
          'characters of explanation. A grade with no reasoning is not a review.',
      );
    }
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }

    const policy = await this.signOffPolicy(input.scope);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const version = await this.versionInStatus(input.scope, input.objectiveId, 'Completed');

      if (!mayTransitionObjective(version.status as ObjectiveStatus, 'OutcomeReview')) {
        throw new ConflictException(
          `A version that is ${OBJECTIVE_STATUS_LABELS[version.status as ObjectiveStatus]} ` +
            'cannot be reviewed.',
        );
      }

      const comparison = await this.compare(input.scope, input.objectiveId, version.id);
      const readiness = readinessForReview(comparison);
      if (!readiness.ready) {
        throw new ConflictException(readiness.blocking);
      }

      const sla = slaOutcome({
        targetDate: comparison.targetDate === null ? null : new Date(comparison.targetDate),
        completedAt: comparison.completedAt === null ? null : new Date(comparison.completedAt),
      });

      const created = await this.prisma.client.objectiveOutcomeReview.create({
        data: {
          tenantId: input.scope.tenantId,
          objectiveId: input.objectiveId,
          objectiveVersionId: version.id,
          verdict: input.verdict,
          actualResult: input.actualResult.trim(),
          ...(input.explanation === undefined || input.explanation.trim() === ''
            ? {}
            : { explanation: input.explanation.trim() }),
          slaOutcome: sla.outcome,
          daysLate: sla.daysLate,
          comparison: comparison as never,
          // The policy **in force now**, stored on the row. A closure judged under this
          // quarter's rule stays judged under it when the company changes the rule later.
          signOffPolicy: policy,
          reviewedByUserId: input.actorUserId,
        },
      });

      await this.prisma.client.objectiveVersion.update({
        where: { id: version.id },
        data: { status: 'OutcomeReview', version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.outcome_reviewed',
        resourceType: 'objective',
        resourceId: input.objectiveId,
        actorUserId: input.actorUserId,
        summary: `Outcome reviewed: ${input.verdict}, ${sla.outcome}.`,
        metadata: {
          verdict: input.verdict,
          slaOutcome: sla.outcome,
          daysLate: sla.daysLate,
          versionId: version.id,
          exceptionsUnresolved: comparison.exceptionsUnresolved,
          aiCostMinor: comparison.aiCostMinor,
          signOffPolicy: policy,
        },
      });

      return ObjectiveClosureService.reviewView(created);
    });
  }

  /**
   * Sign a review off, as the objective's owner.
   *
   * Only the owner: the point of `OwnerSignOff` is that the person accountable for the work sees
   * how it was judged, and a signature from anybody else would satisfy the letter of the policy
   * while defeating it.
   */
  async signOff(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<OutcomeReviewView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const { review, ownerUserId } = await this.openReview(input.scope, input.objectiveId);

      if (input.actorUserId !== ownerUserId) {
        throw new ForbiddenException(
          'Only the objective’s owner signs off its closure. That is the whole point of the ' +
            'policy — the person accountable for the work sees how it was judged.',
        );
      }
      if (review.signedOffAt !== null) {
        throw new ConflictException('That review has already been signed off.');
      }

      const updated = await this.prisma.client.objectiveOutcomeReview.update({
        where: { id: review.id },
        data: {
          signedOffAt: new Date(),
          signedOffByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.outcome_signed_off',
        resourceType: 'objective',
        resourceId: input.objectiveId,
        actorUserId: input.actorUserId,
        resourceVersion: updated.version,
        summary: `The owner signed off the outcome review (${review.verdict}).`,
        metadata: { reviewId: review.id, verdict: review.verdict },
      });

      return ObjectiveClosureService.reviewView(updated);
    });
  }

  /**
   * Close a reviewed objective.
   *
   * `objective:Publish`, plus whatever the sign-off policy requires — `decideClosure` answers
   * that, and the database's `closure_satisfies_its_sign_off_policy` refuses a row that got past
   * it. Both, because "who was allowed to close this" is a question somebody will ask of a row
   * long after the code that wrote it has changed.
   */
  async close(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    approvalRequestId?: string;
  }): Promise<OutcomeReviewView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Publish' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const { review, ownerUserId, version } = await this.openReview(
        input.scope,
        input.objectiveId,
      );

      if (review.closedAt !== null) {
        throw new ConflictException('That objective is already closed.');
      }

      const decision = decideClosure({
        // The policy on the *review*, not the company's current one.
        policy: review.signOffPolicy as ClosureSignOffPolicy,
        actorUserId: input.actorUserId,
        ownerUserId,
        signedOffByUserId: review.signedOffByUserId,
        approvalRequestId: input.approvalRequestId ?? review.approvalRequestId,
      });

      if (!decision.mayClose) {
        throw new ForbiddenException(decision.reason);
      }

      const updated = await this.prisma.client.objectiveOutcomeReview.update({
        where: { id: review.id },
        data: {
          closedAt: new Date(),
          closedByUserId: input.actorUserId,
          ...(input.approvalRequestId === undefined
            ? {}
            : { approvalRequestId: input.approvalRequestId }),
          version: { increment: 1 },
        },
      });

      await this.prisma.client.objectiveVersion.update({
        where: { id: version.id },
        data: { status: 'Closed', version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.closed',
        resourceType: 'objective',
        resourceId: input.objectiveId,
        actorUserId: input.actorUserId,
        resourceVersion: updated.version,
        summary: `Closed with a "${review.verdict}" outcome.`,
        metadata: {
          reviewId: review.id,
          verdict: review.verdict,
          signOffPolicy: review.signOffPolicy,
          signedOffByUserId: review.signedOffByUserId,
          approvalRequestId: updated.approvalRequestId,
        },
      });

      return ObjectiveClosureService.reviewView(updated);
    });
  }

  /**
   * Archive a closed objective.
   *
   * Terminal, and the transition table says so: nothing leaves the archive. A company that wants
   * the work again starts a new draft, which is the versioning rule rather than an exception to it.
   */
  async archive(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<{ status: ObjectiveStatus }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Publish' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const version = await this.prisma.client.objectiveVersion.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          objectiveId: input.objectiveId,
          status: { in: ['Closed', 'Completed'] },
        },
        orderBy: [{ versionNumber: 'desc' }],
      });

      if (version === null) {
        throw new NotFoundException(
          'That objective has no closed or completed version to archive.',
        );
      }

      if (!mayTransitionObjective(version.status as ObjectiveStatus, 'Archived')) {
        throw new ConflictException(
          `A version that is ${OBJECTIVE_STATUS_LABELS[version.status as ObjectiveStatus]} ` +
            'cannot be archived.',
        );
      }

      const archivedFrom = version.status;

      await this.prisma.client.objectiveVersion.update({
        where: { id: version.id },
        data: { status: 'Archived', version: { increment: 1 } },
      });

      // The live pointer is cleared: an archived version is not what the company is running.
      await this.prisma.client.objective.updateMany({
        where: {
          tenantId: input.scope.tenantId,
          id: input.objectiveId,
          activeVersionId: version.id,
        },
        data: { activeVersionId: null },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.archived',
        resourceType: 'objective',
        resourceId: input.objectiveId,
        actorUserId: input.actorUserId,
        summary:
          `Archived from ${archivedFrom}.` +
          (archivedFrom === 'Completed'
            ? ' It was archived without an outcome review, which is permitted and recorded.'
            : ''),
        metadata: {
          versionId: version.id,
          versionNumber: version.versionNumber,
          archivedFrom,
          // Worth recording plainly: an objective archived straight from `Completed` has no
          // review, and a report asking "how did this turn out" will find nothing.
          reviewed: archivedFrom === 'Closed',
        },
      });

      return { status: 'Archived' };
    });
  }

  /** The review of an objective, if it has one. */
  async reviewOf(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<OutcomeReviewView | null> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const row = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.objectiveOutcomeReview.findFirst({
        where: { tenantId: input.scope.tenantId, objectiveId: input.objectiveId },
        orderBy: [{ reviewedAt: 'desc' }],
      }),
    );

    return row === null ? null : ObjectiveClosureService.reviewView(row);
  }

  // -------------------------------------------------------------------------
  // The comparison
  // -------------------------------------------------------------------------

  /**
   * Gather the figures §27.1 asks the review to compare.
   *
   * Each from the module that owns it, and **counted rather than stored**: the snapshot on the
   * review row is taken from this, so there is exactly one place that knows how AI cost is
   * totalled for an objective.
   */
  private async compare(
    scope: TenantScope,
    objectiveId: string,
    versionId: string,
  ): Promise<OutcomeComparison> {
    const version = await this.prisma.client.objectiveVersion.findFirstOrThrow({
      where: { tenantId: scope.tenantId, id: versionId },
    });

    const tasks = await this.prisma.client.humanTask.findMany({
      where: { tenantId: scope.tenantId, objectiveId },
      select: { status: true, startedAt: true, completedAt: true },
    });

    const runs = await this.prisma.client.agentRun.findMany({
      where: { tenantId: scope.tenantId, objectiveId },
      select: { id: true, finishedAt: true },
    });

    const settled = await this.prisma.client.costLedgerEntry.findMany({
      where: {
        tenantId: scope.tenantId,
        objectiveId,
        // Only `Settle` — what the company was actually charged. A `Reserve` is money held and a
        // `ReleaseReserve` gives it back, so summing every kind would double-count.
        kind: 'Settle',
      },
      select: { amountMinor: true, currency: true },
    });

    const exceptions = await this.prisma.client.executorException.findMany({
      where: { tenantId: scope.tenantId, objectiveId },
      select: { state: true },
    });

    // From `HUMAN_TASK_STATUSES`. `Submitted` is deliberately **not** complete: work waiting to
    // be accepted is not work that finished, and counting it would let an objective be reviewed
    // while somebody still had a decision to make.
    const completedStatuses = ['Completed'];

    // Wall-clock, not effort — see `humanElapsedMinutes`. Only tasks with both ends.
    const elapsed = tasks
      .filter((task) => task.startedAt !== null && task.completedAt !== null)
      .map((task) =>
        Math.max(
          0,
          Math.round(
            ((task.completedAt as Date).getTime() - (task.startedAt as Date).getTime()) / 60_000,
          ),
        ),
      );

    // The latest run or task finish, as the objective's completion moment. The version's own
    // `published_at` is when it went live, not when the work ended.
    const finishes = runs
      .map((run) => run.finishedAt)
      .filter((value): value is Date => value !== null);

    return {
      expectedFinalResult: version.expectedFinalResult,
      targetDate: ObjectiveClosureService.targetDate(version)?.toISOString() ?? null,
      completedAt:
        finishes.length === 0
          ? null
          : new Date(Math.max(...finishes.map((at) => at.getTime()))).toISOString(),
      humanTasksTotal: tasks.length,
      humanTasksCompleted: tasks.filter((task) => completedStatuses.includes(task.status)).length,
      humanElapsedMinutes:
        elapsed.length === 0 ? null : elapsed.reduce((total, value) => total + value, 0),
      aiCostMinor: settled.reduce((total, entry) => total + entry.amountMinor, 0),
      aiCostCurrency: settled[0]?.currency ?? 'INR',
      agentRunsTotal: runs.length,
      exceptionsTotal: exceptions.length,
      exceptionsUnresolved: exceptions.filter((row) => row.state !== 'Resolved').length,
    };
  }

  /**
   * Form 2's target date, derived from its target completion time and unit.
   *
   * Form 2 records a *duration* rather than a date — "Target Completion Time" plus a unit — so the
   * date is that duration from publication. Null when either half is missing, which
   * `slaOutcome` then reports as `Unknown` rather than as on time.
   */
  private static targetDate(version: {
    targetCompletionTime: number | null;
    timeUnit: string | null;
    publishedAt: Date | null;
  }): Date | null {
    if (
      version.targetCompletionTime === null ||
      version.timeUnit === null ||
      version.publishedAt === null
    ) {
      return null;
    }

    const days: Record<string, number> = {
      Hours: 1 / 24,
      Days: 1,
      Weeks: 7,
      Months: 30,
      Quarters: 91,
      Years: 365,
    };
    const multiplier = days[version.timeUnit];
    if (multiplier === undefined) return null;

    return new Date(
      version.publishedAt.getTime() + version.targetCompletionTime * multiplier * 86_400_000,
    );
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /**
   * The company's closure sign-off policy, from the settings catalogue.
   *
   * Read through `CompanySettingsService` rather than from a table of its own: it is a company
   * preference, the catalogue is where company preferences live, and a fourth place they could
   * live is a fourth place to look.
   */
  private async signOffPolicy(scope: TenantScope): Promise<ClosureSignOffPolicy> {
    try {
      // `effectiveValue` returns the company's value or the catalogue default, which is exactly
      // this question. It takes no actor because a closure policy is company configuration the
      // closure path has already been authorized to act on.
      const value = await this.settings.effectiveValue(scope, 'objective.closure_sign_off');
      const candidate = String(value);
      return candidate === 'Never' || candidate === 'OwnerSignOff' || candidate === 'Approval'
        ? candidate
        : DEFAULT_CLOSURE_SIGN_OFF_POLICY;
    } catch {
      // A company that has never opened the setting has no row, and the documented default is
      // the answer. Swallowed deliberately: a missing preference is not an error.
      return DEFAULT_CLOSURE_SIGN_OFF_POLICY;
    }
  }

  private async liveVersion(scope: TenantScope, objectiveId: string) {
    const version = await this.prisma.client.objectiveVersion.findFirst({
      where: {
        tenantId: scope.tenantId,
        objectiveId,
        status: { in: ['Active', 'Paused'] },
      },
      orderBy: [{ versionNumber: 'desc' }],
    });

    if (version === null) {
      throw new NotFoundException(
        'That objective has no live version. Only published work can be paused or completed.',
      );
    }
    return version;
  }

  private async versionInStatus(scope: TenantScope, objectiveId: string, status: ObjectiveStatus) {
    const version = await this.prisma.client.objectiveVersion.findFirst({
      where: { tenantId: scope.tenantId, objectiveId, status },
      orderBy: [{ versionNumber: 'desc' }],
    });

    if (version === null) {
      throw new NotFoundException(
        `That objective has no ${OBJECTIVE_STATUS_LABELS[status]} version.`,
      );
    }
    return version;
  }

  private async openReview(scope: TenantScope, objectiveId: string) {
    const version = await this.prisma.client.objectiveVersion.findFirst({
      where: { tenantId: scope.tenantId, objectiveId, status: 'OutcomeReview' },
      orderBy: [{ versionNumber: 'desc' }],
    });

    if (version === null) {
      throw new NotFoundException(
        'That objective is not under outcome review, so there is nothing to sign off or close.',
      );
    }

    const review = await this.prisma.client.objectiveOutcomeReview.findFirst({
      where: { tenantId: scope.tenantId, objectiveVersionId: version.id },
    });

    if (review === null) {
      throw new ConflictException(
        'The version says it is under review and no review exists, which should not happen — ' +
          'the two are written in one transaction.',
      );
    }

    return { review, version, ownerUserId: version.objectiveOwnerUserId };
  }

  private static daysBetween(from: Date, to: Date): number {
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
  }

  private static pauseView(row: {
    id: string;
    reasonKind: string;
    reason: string;
    pausedByUserId: string;
    pausedAt: Date;
    resumedByUserId: string | null;
    resumedAt: Date | null;
    resumeNote: string | null;
  }): ObjectivePauseView {
    return {
      id: row.id,
      reasonKind: row.reasonKind as PauseReason,
      reason: row.reason,
      pausedByUserId: row.pausedByUserId,
      pausedAt: row.pausedAt.toISOString(),
      resumedByUserId: row.resumedByUserId,
      resumedAt: row.resumedAt?.toISOString() ?? null,
      resumeNote: row.resumeNote,
      daysStopped:
        row.resumedAt === null
          ? null
          : ObjectiveClosureService.daysBetween(row.pausedAt, row.resumedAt),
    };
  }

  private static reviewView(row: {
    id: string;
    objectiveId: string;
    objectiveVersionId: string;
    verdict: string;
    actualResult: string;
    explanation: string | null;
    slaOutcome: string;
    daysLate: number | null;
    comparison: unknown;
    signOffPolicy: string;
    reviewedByUserId: string;
    reviewedAt: Date;
    signedOffByUserId: string | null;
    signedOffAt: Date | null;
    approvalRequestId: string | null;
    closedAt: Date | null;
    closedByUserId: string | null;
  }): OutcomeReviewView {
    return {
      id: row.id,
      objectiveId: row.objectiveId,
      objectiveVersionId: row.objectiveVersionId,
      verdict: row.verdict as OutcomeVerdict,
      actualResult: row.actualResult,
      explanation: row.explanation,
      slaOutcome: row.slaOutcome as SlaOutcome,
      daysLate: row.daysLate,
      comparison: row.comparison as OutcomeComparison,
      signOffPolicy: row.signOffPolicy as ClosureSignOffPolicy,
      reviewedByUserId: row.reviewedByUserId,
      reviewedAt: row.reviewedAt.toISOString(),
      signedOffByUserId: row.signedOffByUserId,
      signedOffAt: row.signedOffAt?.toISOString() ?? null,
      approvalRequestId: row.approvalRequestId,
      closedAt: row.closedAt?.toISOString() ?? null,
      closedByUserId: row.closedByUserId,
    };
  }
}
