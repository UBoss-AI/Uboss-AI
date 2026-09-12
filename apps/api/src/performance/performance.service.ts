import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  BadgeLevel,
  PerformanceEvent,
  PerformanceEventKind,
  PerformancePolicy,
} from '../generated/prisma/client.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** The ladder, lowest first — the same order as the UI's `BADGE_LADDER`. */
export const BADGE_LADDER: readonly BadgeLevel[] = [
  'Bronze',
  'Silver',
  'Gold',
  'Platinum',
  'Diamond',
];

/*
 * `BADGE_PERIOD_CLOCK` — **both ends of a badge period come from one clock, this process's.**
 *
 * `startedAt` defaults to `now()`, which inside a transaction is the *transaction start* in the
 * database's clock, while `endedAt` is a `Date` from this process. Those are not the same clock:
 * PostgreSQL runs in a container here, and a few milliseconds of skew is normal. When the
 * database's clock is ahead, closing a period milliseconds after opening it produces
 * `ended_at < started_at`, and the `badge_period_is_ordered` check refuses the write — so
 * somebody crossing two thresholds in quick succession, or offboarded shortly after a badge
 * change, would fail on a clock difference rather than on anything about their performance.
 *
 * So every badge row sets `startedAt` explicitly, and a transition uses **one** `Date` to close
 * the old period and open the new one. The history is then contiguous as well as ordered.
 *
 * Found by this prompt's own exit-snapshot test.
 */

export interface PerformanceView {
  subjectUserId: string;
  /** The sum of every event. Derived, never stored. */
  score: number;
  level: BadgeLevel;
  /** Points to the next level, and which it is. Null at the top. */
  nextLevel: { level: BadgeLevel; pointsAway: number } | null;
  /** On-time deliveries as a percentage of completed work. Null with nothing completed. */
  onTimePercent: number | null;
  counts: Record<string, number>;
  policyVersion: number;
  /** Every level they have held, newest first. */
  badgeHistory: {
    level: BadgeLevel;
    scoreAtChange: number;
    startedAt: string;
    endedAt: string | null;
    isExitSnapshot: boolean;
  }[];
  recentEvents: {
    kind: PerformanceEventKind;
    points: number;
    sourceKind: string;
    sourceId: string;
    reason: string | null;
    occurredAt: string;
    neutralised: boolean;
  }[];
  /** Stated on the wire: a score means nothing without the rules that produced it. */
  note: string;
}

/**
 * The performance score and badge engine.
 *
 * ## The score is derived, never stored
 *
 * Every score is the sum of its `performance_events`. A stored running total nobody can
 * reconstruct is a number people argue about, and "why is my score 240" has to be answerable
 * line by line — which is also what makes a policy change re-derive cleanly instead of needing a
 * migration to fix up totals.
 *
 * ## What produces a positive event
 *
 * The client's rule: work completed **within the required time and accepted/validated**. Both
 * halves. On-time delivery of work that is then rejected is `QualityRejected`, not a positive
 * event — treating it as one is how a score stops meaning anything.
 *
 * ## Idempotency is a database constraint, not a code convention
 *
 * `(tenant, subject, sourceKind, sourceId, kind)` is unique. The callers will be a task-completion
 * handler and a scheduler, both of which retry, so a duplicate must be impossible rather than
 * merely unlikely. `recordEvent` returns the existing event when one is already there.
 *
 * ## The policy is versioned and the event keeps its version
 *
 * Points are scored at the time, under the policy version then active, and stored on the event.
 * A later threshold change re-derives *levels* but never rewrites past *points* — otherwise
 * somebody who earned Gold under one policy would appear to have earned it under another.
 *
 * ## Company-specific, and snapshotted on exit
 *
 * A score belongs to an employment, not to a person: the same human at two employers has two
 * scores, and neither company sees the other's. Offboarding writes a final snapshot so the
 * history stops moving after the person leaves.
 */
@Injectable()
export class PerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organization: OrganizationRepository,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  /** The active policy, creating the baseline if a company somehow has none. */
  async activePolicy(scope: TenantScope): Promise<PerformancePolicy> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.performancePolicy.findFirst({
        where: { tenantId: scope.tenantId, supersededAt: null },
      });
      if (existing) {
        return existing;
      }

      // A company created after the migration's backfill. The engine cannot score without a
      // policy, so the baseline is created on demand rather than refusing — the alternative is
      // performance silently not accruing for a new company until somebody notices.
      return this.prisma.client.performancePolicy.create({
        data: {
          tenantId: scope.tenantId,
          version: 1,
          reason:
            'Baseline policy created on first use so performance can be scored from day one. ' +
            'Thresholds are the documented defaults.',
        },
      });
    });
  }

  /**
   * Replace the active policy with a new version.
   *
   * `performance:Administer`. Never an in-place edit — see the model comment.
   */
  async setPolicy(input: {
    scope: TenantScope;
    actorUserId: string;
    reason: string;
    changes: Partial<{
      onTimeAcceptedPoints: number;
      lateCompletionPoints: number;
      missedPoints: number;
      qualityRejectedPoints: number;
      bronzeThreshold: number;
      silverThreshold: number;
      goldThreshold: number;
      platinumThreshold: number;
      diamondThreshold: number;
      blockersNeutraliseFully: boolean;
      /// Prompt 19A: whether an approved reward’s points may reach the score. Off by default.
      rewardPointsReachPerformance: boolean;
    }>;
  }): Promise<PerformancePolicy> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, {
      module: 'performance',
      action: 'Administer',
    });

    if (!input.reason.trim()) {
      throw new BadRequestException(
        'A performance policy change needs a reason: it changes how everybody in the company is ' +
          'scored, and past scores keep the version that produced them.',
      );
    }

    const current = await this.activePolicy(input.scope);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.prisma.client.performancePolicy.update({
        where: { id: current.id },
        data: { supersededAt: new Date() },
      });

      const created = await this.prisma.client.performancePolicy.create({
        data: {
          tenantId: input.scope.tenantId,
          version: current.version + 1,
          onTimeAcceptedPoints: input.changes.onTimeAcceptedPoints ?? current.onTimeAcceptedPoints,
          lateCompletionPoints: input.changes.lateCompletionPoints ?? current.lateCompletionPoints,
          missedPoints: input.changes.missedPoints ?? current.missedPoints,
          qualityRejectedPoints:
            input.changes.qualityRejectedPoints ?? current.qualityRejectedPoints,
          bronzeThreshold: input.changes.bronzeThreshold ?? current.bronzeThreshold,
          silverThreshold: input.changes.silverThreshold ?? current.silverThreshold,
          goldThreshold: input.changes.goldThreshold ?? current.goldThreshold,
          platinumThreshold: input.changes.platinumThreshold ?? current.platinumThreshold,
          diamondThreshold: input.changes.diamondThreshold ?? current.diamondThreshold,
          blockersNeutraliseFully:
            input.changes.blockersNeutraliseFully ?? current.blockersNeutraliseFully,
          // Prompt 19A. Carried forward from the current version like every other setting, so
          // enabling it once does not silently switch itself off at the next policy change.
          rewardPointsReachPerformance:
            input.changes.rewardPointsReachPerformance ?? current.rewardPointsReachPerformance,
          reason: input.reason.trim(),
          createdByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'performance.policy_versioned',
        resourceType: 'performance_policy',
        resourceId: created.id,
        resourceVersion: created.version,
        actorUserId: input.actorUserId,
        summary: `Performance policy version ${current.version} → ${created.version}.`,
        reason: input.reason.trim(),
        metadata: {
          fromVersion: current.version,
          toVersion: created.version,
          // Past events keep their own version, so no score is rewritten by this.
          pastScoresRewritten: false,
        },
      });

      return created;
    });
  }

  /**
   * Record one scored event. **Idempotent.**
   *
   * Called by the modules that own work — task completion, a scheduler noticing a missed
   * deadline, an approval rejecting a submission. Assumes the caller's transaction where there
   * is one, so scoring and the thing that caused it commit together.
   */
  async recordEvent(input: {
    scope: TenantScope;
    subjectUserId: string;
    kind: PerformanceEventKind;
    sourceKind: string;
    sourceId: string;
    /** Required for `ManualAdjustment` and `BlockerNeutralised`. */
    reason?: string | undefined;
    /** Required for `BlockerNeutralised`: which event it cancels. */
    neutralisesEventId?: string | undefined;
    /** For a manual adjustment, the points. Ignored for every derived kind. */
    points?: number | undefined;
    recordedByUserId?: string | undefined;
    occurredAt?: Date | undefined;
  }): Promise<{ event: PerformanceEvent; alreadyRecorded: boolean }> {
    if (!input.sourceKind.trim() || !input.sourceId.trim()) {
      throw new BadRequestException(
        'A performance event must name what produced it, so a score can be traced back to the ' +
          'work that earned it.',
      );
    }

    if (
      (input.kind === 'ManualAdjustment' || input.kind === 'BlockerNeutralised') &&
      !input.reason?.trim()
    ) {
      throw new BadRequestException(
        `A ${input.kind} needs a reason. It is a decision somebody made rather than an outcome ` +
          'the system observed, and an unexplained adjustment to a score is the one that is disputed.',
      );
    }

    if (input.kind === 'BlockerNeutralised' && input.neutralisesEventId === undefined) {
      throw new BadRequestException(
        'A neutralisation has to name the event it cancels; otherwise the score changes and ' +
          'nothing says which outcome was forgiven.',
      );
    }

    const policy = await this.activePolicy(input.scope);
    const employment = await this.organization.findEmployment(input.scope, input.subjectUserId);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.performanceEvent.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          subjectUserId: input.subjectUserId,
          sourceKind: input.sourceKind.trim(),
          sourceId: input.sourceId.trim(),
          kind: input.kind,
        },
      });

      if (existing) {
        // The retry case, and the reason the unique index exists. Reported rather than silently
        // returning as though a second event had been recorded.
        return { event: existing, alreadyRecorded: true };
      }

      const points = await this.pointsFor(input.scope, policy, input);

      const event = await this.prisma.client.performanceEvent.create({
        data: {
          tenantId: input.scope.tenantId,
          subjectUserId: input.subjectUserId,
          kind: input.kind,
          sourceKind: input.sourceKind.trim(),
          sourceId: input.sourceId.trim(),
          ...(employment === null ? {} : { employmentRecordId: employment.id }),
          points,
          policyId: policy.id,
          policyVersion: policy.version,
          ...(input.neutralisesEventId === undefined
            ? {}
            : { neutralisesEventId: input.neutralisesEventId }),
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          ...(input.recordedByUserId === undefined
            ? {}
            : { recordedByUserId: input.recordedByUserId }),
          ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'performance.event_recorded',
        resourceType: 'performance_event',
        resourceId: event.id,
        ...(input.recordedByUserId === undefined ? {} : { actorUserId: input.recordedByUserId }),
        summary: `${input.kind} scored ${points} for this person.`,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        metadata: {
          subjectUserId: input.subjectUserId,
          kind: input.kind,
          points,
          sourceKind: input.sourceKind.trim(),
          policyVersion: policy.version,
        },
      });

      // The badge is re-evaluated inside the same transaction, so a level and the event that
      // earned it are never separately visible.
      await this.reconcileBadgeWithinCurrentScope(input.scope, input.subjectUserId, policy);

      return { event, alreadyRecorded: false };
    });
  }

  /** One person's performance, as this caller may see it. */
  async viewFor(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
  }): Promise<PerformanceView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // A person may always read their own; reading somebody else's is scoped, so a Manager sees
    // their team and an Employee sees themselves. The engine defers to the Prompt 7 answer
    // rather than inventing a second rule.
    await this.authorization.assertCan(context, {
      module: 'performance',
      action: 'View',
      resource: { id: input.subjectUserId, ownerUserId: input.subjectUserId },
    });

    const policy = await this.activePolicy(input.scope);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const events = await this.prisma.client.performanceEvent.findMany({
        where: { tenantId: input.scope.tenantId, subjectUserId: input.subjectUserId },
        orderBy: { occurredAt: 'desc' },
      });

      const neutralised = new Set(
        events
          .filter((event) => event.neutralisesEventId !== null)
          .map((event) => event.neutralisesEventId as string),
      );

      const score = PerformanceService.scoreOf(events, neutralised, policy);
      const level = PerformanceService.levelFor(score, policy);

      const counts: Record<string, number> = {};
      for (const event of events) {
        counts[event.kind] = (counts[event.kind] ?? 0) + 1;
      }

      const completed =
        (counts['OnTimeAccepted'] ?? 0) +
        (counts['LateCompletion'] ?? 0) +
        (counts['QualityRejected'] ?? 0);

      const history = await this.prisma.client.badgeHistory.findMany({
        where: { tenantId: input.scope.tenantId, subjectUserId: input.subjectUserId },
        orderBy: { startedAt: 'desc' },
        take: 50,
      });

      return {
        subjectUserId: input.subjectUserId,
        score,
        level,
        nextLevel: PerformanceService.nextLevelFor(score, policy),
        onTimePercent:
          completed === 0 ? null : Math.round(((counts['OnTimeAccepted'] ?? 0) / completed) * 100),
        counts,
        policyVersion: policy.version,
        badgeHistory: history.map((row) => ({
          level: row.level,
          scoreAtChange: row.scoreAtChange,
          startedAt: row.startedAt.toISOString(),
          endedAt: row.endedAt?.toISOString() ?? null,
          isExitSnapshot: row.isExitSnapshot,
        })),
        recentEvents: events.slice(0, 50).map((event) => ({
          kind: event.kind,
          points: event.points,
          sourceKind: event.sourceKind,
          sourceId: event.sourceId,
          reason: event.reason,
          occurredAt: event.occurredAt.toISOString(),
          neutralised: neutralised.has(event.id),
        })),
        note:
          `Scored under performance policy version ${policy.version}. The score is the sum of ` +
          'the events below, not a stored total — every point is traceable to the work that ' +
          'earned it, and a later policy change re-derives levels without rewriting past points.',
      };
    });
  }

  /**
   * Write the final snapshot when somebody's employment ends.
   *
   * Called by offboarding. The client's rule: preserve the company-specific score history and a
   * final snapshot on exit. Without it the history would keep re-deriving against a policy that
   * changes after the person has left, so their recorded level could move years later.
   */
  async snapshotOnExitWithinCurrentScope(
    scope: TenantScope,
    subjectUserId: string,
  ): Promise<{ level: BadgeLevel; score: number } | null> {
    const policy = await this.prisma.client.performancePolicy.findFirst({
      where: { tenantId: scope.tenantId, supersededAt: null },
    });
    if (!policy) {
      return null;
    }

    const events = await this.prisma.client.performanceEvent.findMany({
      where: { tenantId: scope.tenantId, subjectUserId },
    });
    if (events.length === 0) {
      // Nobody with no scored work needs a snapshot, and writing one would imply a level they
      // never actually held.
      return null;
    }

    const neutralised = new Set(
      events
        .filter((event) => event.neutralisesEventId !== null)
        .map((event) => event.neutralisesEventId as string),
    );
    const score = PerformanceService.scoreOf(events, neutralised, policy);
    const level = PerformanceService.levelFor(score, policy);

    // One instant for both ends — see `BADGE_PERIOD_CLOCK`. A snapshot is a point in time, so a
    // zero-length period is the honest shape rather than a rounding artefact.
    const at = new Date();

    await this.prisma.client.badgeHistory.updateMany({
      where: { tenantId: scope.tenantId, subjectUserId, endedAt: null },
      data: { endedAt: at },
    });

    await this.prisma.client.badgeHistory.create({
      data: {
        tenantId: scope.tenantId,
        subjectUserId,
        level,
        scoreAtChange: score,
        startedAt: at,
        endedAt: at,
        isExitSnapshot: true,
      },
    });

    await this.auditEvents.appendWithinCurrentScope(scope.tenantId, {
      action: 'performance.exit_snapshot',
      resourceType: 'badge_history',
      resourceId: subjectUserId,
      summary: `Final performance snapshot on employment exit: ${level} at ${score}.`,
      metadata: { subjectUserId, level, score, policyVersion: policy.version },
    });

    return { level, score };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Points for one event, from the policy. A manual adjustment supplies its own. */
  private async pointsFor(
    scope: TenantScope,
    policy: PerformancePolicy,
    input: {
      kind: PerformanceEventKind;
      points?: number | undefined;
      neutralisesEventId?: string | undefined;
    },
  ): Promise<number> {
    switch (input.kind) {
      case 'OnTimeAccepted':
        return policy.onTimeAcceptedPoints;
      case 'LateCompletion':
        return policy.lateCompletionPoints;
      case 'Missed':
        return policy.missedPoints;
      case 'QualityRejected':
        return policy.qualityRejectedPoints;

      case 'ManualAdjustment': {
        if (input.points === undefined || !Number.isInteger(input.points)) {
          throw new BadRequestException('A manual adjustment must state its points.');
        }
        return input.points;
      }

      case 'BlockerNeutralised': {
        // The neutralisation carries the *inverse* of what it cancels, so the arithmetic stays
        // a plain sum. Partial neutralisation halves it, rounded towards zero — a policy that
        // forgives "some" of a missed deadline is a real thing companies ask for, and rounding
        // towards zero means partial forgiveness never becomes a reward.
        const target = await this.prisma.client.performanceEvent.findFirst({
          where: { tenantId: scope.tenantId, id: input.neutralisesEventId as string },
        });
        if (!target) {
          throw new NotFoundException('There is no such event to neutralise.');
        }
        if (target.points >= 0) {
          throw new ConflictException(
            'That event did not cost anything, so there is nothing to neutralise. A blocker ' +
              'forgives a negative outcome; it does not add to a positive one.',
          );
        }
        return policy.blockersNeutraliseFully ? -target.points : Math.trunc(-target.points / 2);
      }

      default: {
        const unreachable: never = input.kind;
        throw new BadRequestException(`Unhandled event kind: ${String(unreachable)}`);
      }
    }
  }

  /**
   * Close the current badge period and open a new one when the level has changed.
   *
   * Assumes the caller's transaction, so an event and the level it produced commit together.
   */
  private async reconcileBadgeWithinCurrentScope(
    scope: TenantScope,
    subjectUserId: string,
    policy: PerformancePolicy,
  ): Promise<void> {
    const events = await this.prisma.client.performanceEvent.findMany({
      where: { tenantId: scope.tenantId, subjectUserId },
    });
    const neutralised = new Set(
      events
        .filter((event) => event.neutralisesEventId !== null)
        .map((event) => event.neutralisesEventId as string),
    );

    const score = PerformanceService.scoreOf(events, neutralised, policy);
    const level = PerformanceService.levelFor(score, policy);

    const current = await this.prisma.client.badgeHistory.findFirst({
      where: { tenantId: scope.tenantId, subjectUserId, endedAt: null },
    });

    if (current?.level === level) {
      return;
    }

    // One instant closes the old period and opens the new one — see `BADGE_PERIOD_CLOCK`. It
    // also makes the history contiguous: no gap between two levels a person actually held.
    const at = new Date();

    if (current) {
      await this.prisma.client.badgeHistory.update({
        where: { id: current.id },
        data: { endedAt: at },
      });
    }

    await this.prisma.client.badgeHistory.create({
      data: {
        tenantId: scope.tenantId,
        subjectUserId,
        level,
        scoreAtChange: score,
        startedAt: at,
      },
    });

    await this.auditEvents.appendWithinCurrentScope(scope.tenantId, {
      action: 'performance.badge_changed',
      resourceType: 'badge_history',
      resourceId: subjectUserId,
      summary: `Badge ${current?.level ?? 'none'} → ${level} at ${score} points.`,
      metadata: { subjectUserId, from: current?.level ?? null, to: level, score },
    });
  }

  /**
   * The sum, with neutralised events removed.
   *
   * Static and pure so the arithmetic is testable without a database — which matters, because
   * this is the function everybody will want to check against their own expectation.
   *
   * A neutralised event and its neutralisation cancel exactly when the policy forgives fully; a
   * partial policy leaves the remainder, which is the point of the setting.
   */
  static scoreOf(
    events: readonly PerformanceEvent[],
    neutralisedIds: ReadonlySet<string>,
    policy: PerformancePolicy,
  ): number {
    return events.reduce((total, event) => {
      // A fully-neutralised negative event contributes nothing, and neither does its
      // neutralisation — summing both would be a no-op with two rows, which is harder to read
      // in a ledger than simply skipping the pair.
      if (policy.blockersNeutraliseFully && neutralisedIds.has(event.id)) {
        return total;
      }
      if (
        policy.blockersNeutraliseFully &&
        event.kind === 'BlockerNeutralised' &&
        event.neutralisesEventId !== null
      ) {
        return total;
      }
      return total + event.points;
    }, 0);
  }

  /** The highest level whose threshold the score meets. */
  static levelFor(score: number, policy: PerformancePolicy): BadgeLevel {
    const thresholds: [BadgeLevel, number][] = [
      ['Diamond', policy.diamondThreshold],
      ['Platinum', policy.platinumThreshold],
      ['Gold', policy.goldThreshold],
      ['Silver', policy.silverThreshold],
      ['Bronze', policy.bronzeThreshold],
    ];

    for (const [level, threshold] of thresholds) {
      if (score >= threshold) {
        return level;
      }
    }

    // Below even the Bronze threshold. The ladder has no rung under it, and inventing one would
    // change the client's five levels — so somebody with a negative score is Bronze with a
    // negative score, which the screen shows honestly.
    return 'Bronze';
  }

  /** The next rung and how far away it is. Null at the top. */
  static nextLevelFor(
    score: number,
    policy: PerformancePolicy,
  ): { level: BadgeLevel; pointsAway: number } | null {
    const ascending: [BadgeLevel, number][] = [
      ['Silver', policy.silverThreshold],
      ['Gold', policy.goldThreshold],
      ['Platinum', policy.platinumThreshold],
      ['Diamond', policy.diamondThreshold],
    ];

    for (const [level, threshold] of ascending) {
      if (score < threshold) {
        return { level, pointsAway: threshold - score };
      }
    }
    return null;
  }
}
