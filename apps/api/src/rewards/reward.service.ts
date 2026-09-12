import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  ALLOWED_AWARD_TRANSITIONS,
  isAwardTerminal,
  mayTransitionAward,
  REWARD_AWARD_STATUS_LABELS,
  settlementRouteFor,
  terminalStatusFor,
  validatePayout,
  validateRuleForAssignment,
  type PayoutRequest,
  type RewardAwardStatus,
  type RewardType,
  type SettlementRoute,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationContext } from '../authorization/authorization.service.js';
import type { Objective, ObjectiveReward, RewardAward } from '../generated/prisma/client.js';
import { PerformanceService } from '../performance/performance.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { PayoutAdapter } from './payout-adapter.js';

export interface RewardAwardView {
  id: string;
  objectiveId: string;
  objectiveCode: string;
  objectiveRewardId: string;
  subjectUserId: string;
  status: RewardAwardStatus;
  statusLabel: string;
  /** The terms as promised at assignment. Frozen — see the model comment. */
  rewardType: RewardType;
  amountMinorUnits: number | null;
  eligibilityCondition: string;
  completionDeadline: string | null;
  approverUserId: string;
  /** How an approved award of this type has to finish. */
  settlementRoute: SettlementRoute;
  assignedAt: string | null;
  assignedByUserId: string | null;
  completedAt: string | null;
  eligibleAt: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  decisionReason: string | null;
  settledAt: string | null;
  settledByUserId: string | null;
  payoutReference: string | null;
  /** **Whether real money moved.** False for every adapter that ships today. */
  payoutWasReal: boolean;
  performanceEventId: string | null;
  performanceNote: string | null;
  nextStatuses: RewardAwardStatus[];
  terminal: boolean;
}

type AwardWithObjective = RewardAward & { objective: Objective };

/**
 * Objective extra work, bonus and reward controls.
 *
 * ## Three client rules shape every method here
 *
 *   1. **Do not auto-pay cash.** `Approved` is a decision, not a payment. Money moves only in
 *      `settle`, which needs a configured payroll connector, a *different* person from the one who
 *      approved, and a stored provider reference. With no connector the product refuses instead of
 *      recording a payment it did not make.
 *   2. **Link approved points to performance only through policy.** An approved points award
 *      writes a performance event only when the company's active policy says reward points may
 *      reach the score, and the default is that they may not. A refusal is a legitimate ending
 *      recorded with a note, not an error.
 *   3. **The panel is outside canonical Form 2.** The rule is `objective_rewards` from Prompt 19;
 *      this service adds the award lifecycle on top of it. There is no second rule table.
 *
 * ## The terms are snapshotted at assignment
 *
 * An award copies the rule's type, amount, condition, deadline and approver when it is assigned,
 * and a database trigger freezes them. Reading the terms through the rule instead would let
 * somebody raise the amount or soften the condition after the work was done, and the trail would
 * show the new terms as though they had always been the terms.
 */
@Injectable()
export class RewardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly performance: PerformanceService,
    private readonly payout: PayoutAdapter,
  ) {}

  // -------------------------------------------------------------------------
  // Assigning
  // -------------------------------------------------------------------------

  /**
   * Assign an award to somebody under an objective's reward rule.
   *
   * `objective:Assign` — the same permission that saves the panel, because promising a bonus and
   * naming who it is promised to are the same kind of decision. Creates the award and moves it
   * straight to `Assigned`: a Draft award nobody is assigned to is the rule, which already exists.
   */
  async assign(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    subjectUserId: string;
  }): Promise<RewardAwardView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Assign' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const { objective, rule } = await this.loadRule(input.objectiveId);
      await this.assertOnObjective(context, objective, 'Assign');

      const problems = validateRuleForAssignment({
        applicable: rule.applicable,
        rewardType: rule.rewardType as RewardType | null,
        amountMinorUnits: rule.amountMinorUnits,
        eligibilityCondition: rule.eligibilityCondition,
        approverUserId: rule.approverUserId,
      });
      if (problems.length > 0) {
        throw new BadRequestException(problems.join(' '));
      }

      // Narrowed by the validation above, but the compiler cannot see that.
      const rewardType = rule.rewardType as RewardType;
      const approverUserId = rule.approverUserId as string;
      const eligibilityCondition = rule.eligibilityCondition as string;

      const open = await this.prisma.client.rewardAward.findFirst({
        where: {
          objectiveRewardId: rule.id,
          subjectUserId: input.subjectUserId,
          status: { notIn: ['Rejected', 'Settled', 'Recorded'] },
        },
      });
      if (open) {
        throw new ConflictException(
          'That person already has an open award under this reward. Settle, record or reject it ' +
            'before assigning another.',
        );
      }

      const now = new Date();
      const award = await this.prisma.client.rewardAward.create({
        data: {
          tenantId: input.scope.tenantId,
          objectiveRewardId: rule.id,
          objectiveId: objective.id,
          subjectUserId: input.subjectUserId,
          status: 'Assigned',
          rewardType,
          amountMinorUnits: rule.amountMinorUnits,
          eligibilityCondition,
          completionDeadline: rule.completionDeadline,
          approverUserId,
          assignedAt: now,
          assignedByUserId: input.actorUserId,
          createdByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'reward.award_assigned',
        resourceType: 'reward_award',
        resourceId: award.id,
        actorUserId: input.actorUserId,
        resourceRef: objective.code,
        summary:
          `Assigned a ${rewardType} reward on "${objective.code}". Nothing is payable: ` +
          'eligibility and approval come later, and cash is never paid automatically.',
        metadata: {
          objectiveId: objective.id,
          subjectUserId: input.subjectUserId,
          rewardType,
          amountMinorUnits: rule.amountMinorUnits,
          approverUserId,
          settlementRoute: settlementRouteFor(rewardType),
          autoPaid: false,
        },
      });

      return this.viewOf(award, objective);
    });
  }

  // -------------------------------------------------------------------------
  // Moving through the chain
  // -------------------------------------------------------------------------

  /**
   * Report the work done: `Assigned -> Completed`.
   *
   * `objective:EditDraft`, and the subject may always report their own. Reporting that you
   * finished is not a claim that you earned the reward — that is the separate `Eligible` finding,
   * which the client's chain names precisely so the two are not the same act.
   */
  async markCompleted(input: {
    scope: TenantScope;
    actorUserId: string;
    awardId: string;
  }): Promise<RewardAwardView> {
    return this.move({
      ...input,
      to: 'Completed',
      permission: 'EditDraft',
      allowSubject: true,
      patch: (actorUserId) => ({ completedAt: new Date(), completedByUserId: actorUserId }),
      audit: 'reward.award_completed',
      summary: 'Reported the work for this reward as complete.',
    });
  }

  /**
   * Judge the condition met: `Completed -> Eligible`.
   *
   * `objective:Assign`, and **never** the subject themselves. Declaring your own work eligible for
   * your own bonus is the self-dealing case, and it is refused here rather than left to the
   * approver to notice.
   */
  async markEligible(input: {
    scope: TenantScope;
    actorUserId: string;
    awardId: string;
  }): Promise<RewardAwardView> {
    return this.move({
      ...input,
      to: 'Eligible',
      permission: 'Assign',
      allowSubject: false,
      refuseSubject:
        'You cannot declare your own work eligible for your own reward. Somebody else has to ' +
        'find the condition met.',
      patch: (actorUserId) => ({ eligibleAt: new Date(), eligibleByUserId: actorUserId }),
      audit: 'reward.award_eligible',
      summary: 'Found the eligibility condition met.',
    });
  }

  /**
   * Approve: `Eligible -> Approved`.
   *
   * `objective:Approve`, **and** the actor must be the approver named on the rule when the award
   * was assigned. A permission says who may approve things in general; the rule says who may
   * approve *this*, and the client's model is that the named approver is the one accountable. The
   * subject can never approve their own award even if they hold the permission.
   *
   * Approving pays nobody. It moves the award to a decision, and the money — or the points —
   * happens in `settle` or `record`.
   */
  async approve(input: {
    scope: TenantScope;
    actorUserId: string;
    awardId: string;
    reason?: string | undefined;
  }): Promise<RewardAwardView> {
    return this.move({
      scope: input.scope,
      actorUserId: input.actorUserId,
      awardId: input.awardId,
      to: 'Approved',
      permission: 'Approve',
      allowSubject: false,
      refuseSubject: 'You cannot approve your own reward.',
      requireNamedApprover: true,
      patch: (actorUserId) => ({
        decidedAt: new Date(),
        decidedByUserId: actorUserId,
        ...(input.reason === undefined ? {} : { decisionReason: input.reason }),
      }),
      audit: 'reward.award_approved',
      summary:
        'Approved this reward. **Nothing is paid by approving**: a cash award still needs a ' +
        'separate settlement by a different person through an approved payroll connector.',
    });
  }

  /**
   * Reject, from any open state. A reason is required and the database insists too.
   *
   * Reachable from `Draft`, `Assigned`, `Completed` and `Eligible`, because a claim can fail
   * because the work was not done, because the condition was not met, or because the approver said
   * no. Forcing every rejection through `Eligible` would mean declaring somebody eligible in order
   * to refuse them.
   */
  async reject(input: {
    scope: TenantScope;
    actorUserId: string;
    awardId: string;
    reason: string;
  }): Promise<RewardAwardView> {
    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'A rejection needs a reason. An unexplained refusal of somebody’s bonus is the one that ' +
          'is disputed.',
      );
    }

    return this.move({
      scope: input.scope,
      actorUserId: input.actorUserId,
      awardId: input.awardId,
      to: 'Rejected',
      permission: 'Approve',
      allowSubject: false,
      refuseSubject: 'You cannot decide your own reward.',
      patch: (actorUserId) => ({
        decidedAt: new Date(),
        decidedByUserId: actorUserId,
        decisionReason: input.reason,
      }),
      audit: 'reward.award_rejected',
      summary: `Rejected this reward: ${input.reason}`,
    });
  }

  // -------------------------------------------------------------------------
  // Finishing
  // -------------------------------------------------------------------------

  /**
   * Settle a cash award through the payroll connector: `Approved -> Settled`.
   *
   * The whole of "do not auto-pay cash" lives in this method's preconditions. All of these must
   * hold, and each is checked separately so a failure says which one:
   *
   *   * the award is `Approved` — a decision has been made;
   *   * its type is `Cash` — points and recognition are `record`ed, never settled;
   *   * the actor is **not** the person who approved it (four eyes on the money);
   *   * a payroll connector is configured and says it can pay.
   *
   * With no connector configured this refuses. `payoutWasReal` records what the adapter actually
   * did, so a report can never claim a settlement was real when it was not.
   */
  async settle(input: {
    scope: TenantScope;
    actorUserId: string;
    awardId: string;
    currency?: string | undefined;
  }): Promise<RewardAwardView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Approve' });

    const loaded = await this.loadAward(input.scope, input.awardId);
    await this.assertOnObjective(context, loaded.objective, 'Approve');

    if (loaded.status !== 'Approved') {
      throw new ConflictException(
        `An award that is ${REWARD_AWARD_STATUS_LABELS[loaded.status as RewardAwardStatus]} ` +
          'cannot be settled. Only an approved award can be.',
      );
    }

    if (loaded.decidedByUserId === input.actorUserId) {
      throw new ForbiddenException(
        'The person who approved a reward cannot also pay it out. A settlement needs a second ' +
          'person.',
      );
    }

    const problems = validatePayout({
      rewardType: loaded.rewardType as RewardType,
      amountMinorUnits: loaded.amountMinorUnits,
      connectorConfigured: this.payout.canSettle,
    });
    if (problems.length > 0) {
      throw new BadRequestException(problems.join(' '));
    }

    const request: PayoutRequest = {
      awardId: loaded.id,
      subjectUserId: loaded.subjectUserId,
      amountMinorUnits: loaded.amountMinorUnits as number,
      currency: input.currency ?? 'INR',
      memo: `UBoss reward for objective ${loaded.objective.code}`,
    };

    // Outside the transaction on purpose: an external call must not hold a database transaction
    // open, and a failed payout must leave the award `Approved` rather than half-settled.
    const result = await this.payout.settle(request);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const settled = await this.prisma.client.rewardAward.update({
        where: { id: loaded.id },
        data: {
          status: 'Settled',
          settledAt: new Date(),
          settledByUserId: input.actorUserId,
          payoutReference: result.reference,
          payoutWasReal: result.deliveredRealPayment,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'reward.award_settled',
        resourceType: 'reward_award',
        resourceId: settled.id,
        actorUserId: input.actorUserId,
        resourceRef: result.reference,
        resourceVersion: settled.version,
        summary: result.deliveredRealPayment
          ? `Settled through ${this.payout.kind}, reference ${result.reference}.`
          : `Recorded a settlement through ${this.payout.kind} (${result.reference}). ` +
            '**No real payment was made** — the connector is not a live payroll provider.',
        metadata: {
          connector: this.payout.kind,
          reference: result.reference,
          // The single most important field in this trail.
          payoutWasReal: result.deliveredRealPayment,
          amountMinorUnits: request.amountMinorUnits,
          currency: request.currency,
          approvedByUserId: loaded.decidedByUserId,
          settledByUserId: input.actorUserId,
          detail: result.detail,
        },
      });

      return this.viewOf(settled, loaded.objective);
    });
  }

  /**
   * Record a non-cash award: `Approved -> Recorded`.
   *
   * For a **points** award this is where the policy gate is applied. The event is written only if
   * the company's active performance policy says reward points may reach the score; if it does
   * not, the award still finishes, with a note saying why no event was written. A refusal is an
   * ending, not an error — and the note is what stops the absence looking like a bug.
   *
   * A cash award can never come here, and a recorded award never produces money.
   */
  async record(input: {
    scope: TenantScope;
    actorUserId: string;
    awardId: string;
  }): Promise<RewardAwardView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Approve' });

    const loaded = await this.loadAward(input.scope, input.awardId);
    await this.assertOnObjective(context, loaded.objective, 'Approve');

    if (loaded.status !== 'Approved') {
      throw new ConflictException(
        `An award that is ${REWARD_AWARD_STATUS_LABELS[loaded.status as RewardAwardStatus]} ` +
          'cannot be recorded. Only an approved award can be.',
      );
    }

    const rewardType = loaded.rewardType as RewardType;
    if (settlementRouteFor(rewardType) === 'Payout') {
      throw new BadRequestException(
        'A cash award is settled through payroll, not recorded. Use settle.',
      );
    }

    const policy = await this.performance.activePolicy(input.scope);
    const points = loaded.amountMinorUnits ?? 0;

    // The gate. Three separate reasons not to score, each recorded in its own words so the
    // absence of a performance event is always explained.
    let performanceEventId: string | null = null;
    let performanceNote: string | null = null;

    if (rewardType !== 'Points') {
      performanceNote = `A ${rewardType} reward carries no points, so nothing reaches the performance score.`;
    } else if (!policy.rewardPointsReachPerformance) {
      performanceNote =
        'The active performance policy does not let reward points reach the score. Approved ' +
        'points link to performance only through policy, and this company has not enabled it.';
    } else if (points <= 0) {
      performanceNote = 'The award carries no points, so there is nothing to record.';
    } else {
      const recorded = await this.performance.recordEvent({
        scope: input.scope,
        subjectUserId: loaded.subjectUserId,
        kind: 'ManualAdjustment',
        sourceKind: 'reward_award',
        sourceId: loaded.id,
        points,
        reason: `Approved reward on objective ${loaded.objective.code}: ${loaded.eligibilityCondition}`,
        recordedByUserId: input.actorUserId,
      });
      performanceEventId = recorded.event.id;
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const done = await this.prisma.client.rewardAward.update({
        where: { id: loaded.id },
        data: {
          status: 'Recorded',
          settledAt: new Date(),
          settledByUserId: input.actorUserId,
          performanceEventId,
          performanceNote,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'reward.award_recorded',
        resourceType: 'reward_award',
        resourceId: done.id,
        actorUserId: input.actorUserId,
        resourceRef: loaded.objective.code,
        resourceVersion: done.version,
        summary:
          performanceEventId === null
            ? `Recorded this reward. No performance event was written: ${performanceNote ?? ''}`
            : `Recorded this reward and ${points} points against performance, as policy permits.`,
        metadata: {
          rewardType,
          points,
          performanceEventId,
          performanceNote,
          policyPermitsRewardPoints: policy.rewardPointsReachPerformance,
          // Nothing was paid, and the trail says so rather than leaving it to be inferred.
          payoutWasReal: false,
        },
      });

      return this.viewOf(done, loaded.objective);
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Every award on one objective. `objective:View`, plus the row-level check. */
  async listForObjective(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<{ awards: RewardAwardView[]; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const objective = await this.prisma.client.objective.findUnique({
        where: { id: input.objectiveId },
      });
      if (!objective) {
        throw new NotFoundException('There is no such objective you can see.');
      }
      await this.assertOnObjective(context, objective, 'View');

      const awards = await this.prisma.client.rewardAward.findMany({
        where: { objectiveId: objective.id },
        orderBy: { createdAt: 'asc' },
      });

      return {
        awards: awards.map((award) => this.viewOf(award, objective)),
        note:
          'Approving a reward is a decision, not a payment. A cash award is settled only through ' +
          'an approved payroll connector, by somebody other than the approver, and no connector ' +
          'is configured today. Approved points reach the performance score only if the ' +
          'company’s performance policy permits it.',
      };
    });
  }

  /**
   * One person's awards across the company.
   *
   * **Always permitted to themselves**, the same rule as their own performance score. The
   * row-level scope check only applies when looking at *somebody else's* awards, and that
   * asymmetry is a fix rather than a shortcut: a person's own award has no department on the
   * resource descriptor, so a `Department`-scoped Head asking about their own bonus was refused
   * as unevaluable. Being told you may not see your own bonus is absurd, and it is exactly what
   * a uniform check produced.
   */
  async listForSubject(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
  }): Promise<{ awards: RewardAwardView[] }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    /**
     * `performance`, not `objective` — a CR-03 correction.
     *
     * This checked `objective:View`, which worked only because a standard Employee happened to
     * hold it. CR-03 (Prompt 40A) made an Employee operations-only, and the effect was that a
     * person could no longer see **their own bonus** — the same absurdity the asymmetry above was
     * written to prevent, arriving through a different door.
     *
     * `performance:View` is both the fix and the more accurate gate: a reward award is
     * performance information about a person, not part of authoring an Objective. The real
     * restriction has always been the row-level check below, which is what decides whose awards
     * you may read; the module grant was never what kept one person out of another's.
     */
    await this.authorization.assertCan(context, { module: 'performance', action: 'View' });

    if (input.subjectUserId !== input.actorUserId) {
      await this.authorization.assertCan(context, {
        module: 'performance',
        action: 'View',
        resource: { id: input.subjectUserId, ownerUserId: input.subjectUserId },
      });
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const awards = await this.prisma.client.rewardAward.findMany({
        where: { subjectUserId: input.subjectUserId },
        include: { objective: true },
        orderBy: { createdAt: 'desc' },
      });

      return {
        awards: (awards as AwardWithObjective[]).map((award) =>
          this.viewOf(award, award.objective),
        ),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One transition, with every check that every transition needs.
   *
   * The shared shape is deliberate: each of the four movers differs only in its target status, its
   * permission, whether the subject may do it, and what it stamps. Writing them separately is how
   * one of them ends up missing the terminal check or the transition table.
   */
  private async move(input: {
    scope: TenantScope;
    actorUserId: string;
    awardId: string;
    to: RewardAwardStatus;
    permission: 'EditDraft' | 'Assign' | 'Approve';
    allowSubject: boolean;
    refuseSubject?: string | undefined;
    requireNamedApprover?: boolean | undefined;
    patch: (actorUserId: string) => Record<string, unknown>;
    audit: string;
    summary: string;
  }): Promise<RewardAwardView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    const loaded = await this.loadAward(input.scope, input.awardId);
    const isSubject = loaded.subjectUserId === input.actorUserId;

    if (isSubject && !input.allowSubject) {
      throw new ForbiddenException(input.refuseSubject ?? 'You cannot do that to your own reward.');
    }

    // The subject reporting their own completion needs no wider permission: it is their own work.
    if (!(isSubject && input.allowSubject)) {
      await this.authorization.assertCan(context, {
        module: 'objective',
        action: input.permission,
      });
      await this.assertOnObjective(context, loaded.objective, input.permission);
    }

    if (input.requireNamedApprover === true && loaded.approverUserId !== input.actorUserId) {
      throw new ForbiddenException(
        'Only the approver named on this reward may decide it. Holding the permission is not ' +
          'the same as being the named approver.',
      );
    }

    const from = loaded.status as RewardAwardStatus;

    if (isAwardTerminal(from)) {
      throw new ConflictException(
        `This award is ${REWARD_AWARD_STATUS_LABELS[from]} and is finished. Correct a mistake ` +
          'with a new award and a reason; never by reopening one that has been settled, recorded ' +
          'or refused.',
      );
    }

    if (!mayTransitionAward(from, input.to)) {
      throw new ConflictException(
        `An award that is ${REWARD_AWARD_STATUS_LABELS[from]} cannot become ` +
          `${REWARD_AWARD_STATUS_LABELS[input.to]}.`,
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const moved = await this.prisma.client.rewardAward.update({
        where: { id: loaded.id },
        data: {
          status: input.to,
          ...input.patch(input.actorUserId),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: input.audit,
        resourceType: 'reward_award',
        resourceId: moved.id,
        actorUserId: input.actorUserId,
        resourceRef: loaded.objective.code,
        resourceVersion: moved.version,
        summary: input.summary,
        metadata: {
          from,
          to: input.to,
          subjectUserId: loaded.subjectUserId,
          rewardType: loaded.rewardType,
          // True of every transition in this method: none of them pays anybody.
          payoutWasReal: false,
        },
      });

      return this.viewOf(moved, loaded.objective);
    });
  }

  private async loadRule(
    objectiveId: string,
  ): Promise<{ objective: Objective; rule: ObjectiveReward }> {
    const objective = await this.prisma.client.objective.findUnique({
      where: { id: objectiveId },
    });
    if (!objective) {
      throw new NotFoundException('There is no such objective you can see.');
    }

    const rule = await this.prisma.client.objectiveReward.findUnique({
      where: { objectiveId },
    });
    if (!rule) {
      throw new BadRequestException(
        'This objective has no Performance & Reward panel. Save one before assigning a reward.',
      );
    }

    return { objective, rule };
  }

  private async loadAward(scope: TenantScope, awardId: string): Promise<AwardWithObjective> {
    // Reading outside a tenant transaction returns nothing under Row-Level Security.
    return this.prisma.runInTenantTransaction(scope, async () => {
      const award = await this.prisma.client.rewardAward.findUnique({
        where: { id: awardId },
        include: { objective: true },
      });
      if (!award) {
        throw new NotFoundException('There is no such reward award you can see.');
      }
      return award as AwardWithObjective;
    });
  }

  private async assertOnObjective(
    context: AuthorizationContext,
    objective: Objective,
    action: 'View' | 'EditDraft' | 'Assign' | 'Approve',
  ): Promise<void> {
    await this.authorization.assertCan(context, {
      module: 'objective',
      action,
      resource: {
        id: objective.id,
        ownerUserId: objective.objectiveOwnerUserId,
        departmentId: objective.departmentId,
        ...(objective.createdByUserId === null
          ? {}
          : { createdByUserId: objective.createdByUserId }),
      },
    });
  }

  private viewOf(award: RewardAward, objective: Objective): RewardAwardView {
    const status = award.status as RewardAwardStatus;
    const rewardType = award.rewardType as RewardType;

    return {
      id: award.id,
      objectiveId: award.objectiveId,
      objectiveCode: objective.code,
      objectiveRewardId: award.objectiveRewardId,
      subjectUserId: award.subjectUserId,
      status,
      statusLabel: REWARD_AWARD_STATUS_LABELS[status],
      rewardType,
      amountMinorUnits: award.amountMinorUnits,
      eligibilityCondition: award.eligibilityCondition,
      completionDeadline:
        award.completionDeadline === null
          ? null
          : award.completionDeadline.toISOString().slice(0, 10),
      approverUserId: award.approverUserId,
      settlementRoute: settlementRouteFor(rewardType),
      assignedAt: award.assignedAt?.toISOString() ?? null,
      assignedByUserId: award.assignedByUserId,
      completedAt: award.completedAt?.toISOString() ?? null,
      eligibleAt: award.eligibleAt?.toISOString() ?? null,
      decidedAt: award.decidedAt?.toISOString() ?? null,
      decidedByUserId: award.decidedByUserId,
      decisionReason: award.decisionReason,
      settledAt: award.settledAt?.toISOString() ?? null,
      settledByUserId: award.settledByUserId,
      payoutReference: award.payoutReference,
      payoutWasReal: award.payoutWasReal,
      performanceEventId: award.performanceEventId,
      performanceNote: award.performanceNote,
      nextStatuses: [...ALLOWED_AWARD_TRANSITIONS[status]],
      terminal: isAwardTerminal(status),
    };
  }

  /** Which status an approved award of this type will finish in. Exposed for the screen. */
  static endingFor(rewardType: RewardType): 'Settled' | 'Recorded' {
    return terminalStatusFor(rewardType);
  }
}
