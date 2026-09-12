import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  evaluationEligibility,
  FEEDBACK_GIVE_ACTION,
  FEEDBACK_PROMOTE_ACTION,
  FEEDBACK_PROMOTE_MODULE,
  FEEDBACK_TRAINING_STANCE,
  feedbackEligibility,
  feedbackProblems,
  summariseQuality,
  type FeedbackRating,
  type QualitySummary,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

export interface FeedbackView {
  id: string;
  runId: string;
  rating: FeedbackRating;
  correction: string | null;
  evidence: string | null;
  reviewerUserId: string;
  /** False for a mock-model result. Never omitted, so no figure can imply it was real. */
  producedByRealModel: boolean | null;
  evaluationEligible: boolean;
  evaluationReason: string | null;
  promotedCaseId: string | null;
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * AI output feedback and correction — Prompt 33.
 *
 * ## The one sentence that shapes this service
 *
 * Prompt 33: *"Do NOT assume or automatically enable external provider model training on company
 * data."* So feedback goes exactly two places, both inside UBoss: the company's own quality
 * figures, and — when somebody with the right grant promotes it — the company's own Prompt 18
 * evaluation cases. There is no third destination, no consent field and no adapter parameter, and
 * `FEEDBACK_TRAINING_STANCE` says so in words the UI shows.
 *
 * ## Why promotion is a separate act
 *
 * §27.1 says feedback "feeds Agent/Skill quality and evaluation workflows". Quality is automatic:
 * a rating counts the moment it is given. An **evaluation case** is not, because it is a permanent
 * assertion about how a Skill must behave, and it will fail somebody's release six months from
 * now. An Employee's rating is welcome; an Employee silently creating a regression gate is not.
 * So `submit` needs `Comment` on `agents` and `promote` needs `EditDraft` on `skills`.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  /** What the UI needs to render the control, including what UBoss will not do with the answer. */
  meta(): { stance: string; promoteAction: string; promoteModule: string } {
    return {
      stance: FEEDBACK_TRAINING_STANCE,
      promoteAction: FEEDBACK_PROMOTE_ACTION,
      promoteModule: FEEDBACK_PROMOTE_MODULE,
    };
  }

  /**
   * Rate an AI output.
   *
   * `agents:Comment` — the action for "has something to say about this work without changing it",
   * which is exactly what a rating is, and an Employee holds it. The person who does the work is
   * usually the one who can tell whether the output was right, so gating feedback on a manager's
   * grant would silence the best-placed reviewer.
   */
  async submit(input: {
    scope: TenantScope;
    actorUserId: string;
    runId: string;
    rating: FeedbackRating;
    correction?: string | null;
    evidence?: string | null;
  }): Promise<FeedbackView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, {
      module: 'agents',
      action: FEEDBACK_GIVE_ACTION,
    });

    const problems = feedbackProblems({
      rating: input.rating,
      correction: input.correction ?? null,
      evidence: input.evidence ?? null,
    });
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }

    const run = await this.runFor(input.scope, input.runId);

    const existing = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.aiOutputFeedback.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          runId: input.runId,
          reviewerUserId: input.actorUserId,
        },
        select: { id: true },
      }),
    );

    const eligibility = feedbackEligibility({
      hasOutput: run.output !== null,
      producedByRealModel: run.producedByRealModel,
      alreadyRatedByReviewer: existing !== null,
      sameTenant: true,
    });

    if (!eligibility.permitted) {
      throw new ForbiddenException(eligibility.reason);
    }

    const evaluation = evaluationEligibility({
      rating: input.rating,
      correction: input.correction ?? null,
      skillVersionIds: run.skillVersionIds,
    });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const created = await this.prisma.client.aiOutputFeedback.create({
        data: {
          tenantId: input.scope.tenantId,
          runId: input.runId,
          rating: input.rating,
          ...(input.correction == null ? {} : { correction: input.correction }),
          ...(input.evidence == null ? {} : { evidence: input.evidence }),
          reviewerUserId: input.actorUserId,
          // Copied, not joined. A quality figure computed from this table alone can then never
          // present mock output as a provider's (ADR-183).
          producedByRealModel: run.producedByRealModel,
          evaluationEligible: evaluation.eligible,
          evaluationReason: evaluation.eligible ? null : evaluation.reason,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'feedback.submitted',
        resourceType: 'agent-run',
        resourceId: input.runId,
        actorUserId: input.actorUserId,
        summary: `AI output rated ${input.rating}.`,
        metadata: {
          rating: input.rating,
          evaluationEligible: evaluation.eligible,
          producedByRealModel: run.producedByRealModel,
        },
      });

      return FeedbackService.toView(created);
    });
  }

  /**
   * Amend your own rating.
   *
   * Only your own, and deliberately: a manager overwriting an employee's judgement of an AI
   * output would make the quality figures a record of what management thinks rather than of what
   * happened. The previous rating lives on the audit trail, which is append-only.
   */
  async amend(input: {
    scope: TenantScope;
    actorUserId: string;
    feedbackId: string;
    rating: FeedbackRating;
    correction?: string | null;
    evidence?: string | null;
  }): Promise<FeedbackView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, {
      module: 'agents',
      action: FEEDBACK_GIVE_ACTION,
    });

    const problems = feedbackProblems({
      rating: input.rating,
      correction: input.correction ?? null,
      evidence: input.evidence ?? null,
    });
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }

    const existing = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.aiOutputFeedback.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.feedbackId },
      }),
    );

    if (existing === null) {
      throw new NotFoundException('That feedback does not exist in this company.');
    }
    if (existing.reviewerUserId !== input.actorUserId) {
      throw new ForbiddenException(
        'You can only amend your own feedback. Somebody else’s judgement of an AI output is ' +
          'theirs to change.',
      );
    }
    if (existing.promotedAt !== null) {
      throw new ForbiddenException(
        'This feedback has become an evaluation case, so its correction is now an assertion ' +
          'other work depends on. Retire the case first.',
      );
    }

    const run = await this.runFor(input.scope, existing.runId);
    const evaluation = evaluationEligibility({
      rating: input.rating,
      correction: input.correction ?? null,
      skillVersionIds: run.skillVersionIds,
    });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const updated = await this.prisma.client.aiOutputFeedback.update({
        where: { id: existing.id },
        data: {
          rating: input.rating,
          correction: input.correction ?? null,
          evidence: input.evidence ?? null,
          evaluationEligible: evaluation.eligible,
          evaluationReason: evaluation.eligible ? null : evaluation.reason,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'feedback.amended',
        resourceType: 'agent-run',
        resourceId: existing.runId,
        actorUserId: input.actorUserId,
        summary: `Feedback changed from ${existing.rating} to ${input.rating}.`,
        resourceVersion: updated.version,
        metadata: {
          before: existing.rating,
          after: input.rating,
          // Both, because "what did they say before" is on the trail or it is nowhere.
          beforeCorrection: existing.correction ?? '',
        },
      });

      return FeedbackService.toView(updated);
    });
  }

  /** One run's feedback, for the drawer that shows it. */
  async listForRun(input: {
    scope: TenantScope;
    actorUserId: string;
    runId: string;
  }): Promise<FeedbackView[]> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'View' });

    const rows = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.aiOutputFeedback.findMany({
        where: { tenantId: input.scope.tenantId, runId: input.runId },
        orderBy: [{ createdAt: 'desc' }],
      }),
    );

    return rows.map((row) => FeedbackService.toView(row));
  }

  /**
   * An agent's quality, from its feedback.
   *
   * `onRealModelOutput` travels with the figure because a 100% correct rate over mock output says
   * nothing about a provider's quality. Prompt 29's rule — a result always carries whether a real
   * model produced it — reaches the quality figures here.
   */
  async quality(input: {
    scope: TenantScope;
    actorUserId: string;
    engineAgentId?: string;
  }): Promise<QualitySummary> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'View' });

    const rows = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.aiOutputFeedback.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.engineAgentId === undefined
            ? {}
            : { run: { engineAgentId: input.engineAgentId } }),
        },
        select: { rating: true, producedByRealModel: true },
      }),
    );

    return summariseQuality(
      rows.map((row) => ({
        rating: row.rating as FeedbackRating,
        producedByRealModel: row.producedByRealModel,
      })),
    );
  }

  /**
   * Turn feedback into an evaluation case.
   *
   * `skills:EditDraft`, on the Prompt 18 tables rather than a new store: the correction becomes
   * the case's `expected`, the run's output becomes context, and the Skill's existing regression
   * machinery does the rest. A second dataset beside `skill_evaluation_cases` would mean two
   * answers to "what must this Skill do".
   */
  async promote(input: {
    scope: TenantScope;
    actorUserId: string;
    feedbackId: string;
    skillVersionId: string;
    name: string;
  }): Promise<{ caseId: string; feedback: FeedbackView }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, {
      module: FEEDBACK_PROMOTE_MODULE,
      action: FEEDBACK_PROMOTE_ACTION,
    });

    const feedback = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.aiOutputFeedback.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.feedbackId },
      }),
    );

    if (feedback === null) {
      throw new NotFoundException('That feedback does not exist in this company.');
    }
    if (!feedback.evaluationEligible) {
      throw new BadRequestException(
        feedback.evaluationReason ??
          'That feedback cannot become an evaluation case. A correct rating has no expected ' +
            'answer different from what happened.',
      );
    }
    if (feedback.promotedAt !== null) {
      throw new ForbiddenException('That feedback is already an evaluation case.');
    }

    const skillVersion = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.skillVersion.findFirst({
        where: { id: input.skillVersionId },
        select: { id: true, skillId: true, skill: { select: { tenantId: true } } },
      }),
    );

    if (skillVersion === null) {
      throw new NotFoundException('That Skill version does not exist.');
    }
    // A platform Skill has a null tenant and is shared; a company Skill must be this company's.
    // Without this a company could attach a regression case to another company's Skill.
    if (
      skillVersion.skill.tenantId !== null &&
      skillVersion.skill.tenantId !== input.scope.tenantId
    ) {
      throw new NotFoundException('That Skill version does not exist.');
    }

    const run = await this.runFor(input.scope, feedback.runId);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const created = await this.prisma.client.skillEvaluationCase.create({
        data: {
          tenantId: input.scope.tenantId,
          skillId: skillVersion.skillId,
          name: input.name,
          description:
            `From feedback on run ${feedback.runId}: rated ${feedback.rating} by a reviewer, ` +
            'with the correction below as the expected answer.',
          inputs: { runId: feedback.runId, output: run.output } as never,
          // `HumanJudged`, which is what a reviewer's correction actually is. The alternatives
          // would both be wrong: `ExactMatch` fails on a better answer than the one the reviewer
          // wrote, and `ContainsAll` treats a sentence of prose as a list of required fragments.
          // Prompt 18 defined this kind as "a person judged it — recorded, never computed", which
          // is exactly the provenance of a case built from human feedback. Somebody has to look
          // at the result, and pretending otherwise would produce a regression gate that fails
          // for the wrong reasons.
          assertion: 'HumanJudged',
          expected: feedback.correction ?? '',
          createdByUserId: input.actorUserId,
        },
      });

      const updated = await this.prisma.client.aiOutputFeedback.update({
        where: { id: feedback.id },
        data: {
          promotedCaseId: created.id,
          promotedAt: new Date(),
          promotedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'feedback.promoted_to_evaluation_case',
        resourceType: 'skill-evaluation-case',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary: `Feedback on run ${feedback.runId} became evaluation case "${input.name}".`,
        metadata: {
          feedbackId: feedback.id,
          skillId: skillVersion.skillId,
          rating: feedback.rating,
          // Stated on the record: this is a UBoss evaluation case, not data sent anywhere.
          destination: 'uboss-evaluation-dataset',
        },
      });

      return { caseId: created.id, feedback: FeedbackService.toView(updated) };
    });
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /**
   * The run, plus the Skill versions its configuration names.
   *
   * The Skill link is derived rather than stored on the run: a run cites an immutable agent
   * version, and that version's config names the Skill versions. Storing it again on the run
   * would be a second copy that could disagree with the version that actually produced the work.
   */
  private async runFor(
    scope: TenantScope,
    runId: string,
  ): Promise<{
    output: unknown;
    producedByRealModel: boolean | null;
    engineAgentId: string;
    skillVersionIds: string[];
  }> {
    const run = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.agentRun.findFirst({
        where: { tenantId: scope.tenantId, id: runId },
        select: {
          output: true,
          producedByRealModel: true,
          engineAgentId: true,
          agentVersion: { select: { config: true } },
        },
      }),
    );

    if (run === null) {
      throw new NotFoundException('That run does not exist in this company.');
    }

    const config = run.agentVersion.config as { skillVersionIds?: unknown } | null;
    const ids = Array.isArray(config?.skillVersionIds)
      ? config.skillVersionIds.filter((id): id is string => typeof id === 'string')
      : [];

    return {
      output: run.output,
      producedByRealModel: run.producedByRealModel,
      engineAgentId: run.engineAgentId,
      skillVersionIds: ids,
    };
  }

  private static toView(row: {
    id: string;
    runId: string;
    rating: string;
    correction: string | null;
    evidence: string | null;
    reviewerUserId: string;
    producedByRealModel: boolean | null;
    evaluationEligible: boolean;
    evaluationReason: string | null;
    promotedCaseId: string | null;
    promotedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): FeedbackView {
    return {
      id: row.id,
      runId: row.runId,
      rating: row.rating as FeedbackRating,
      correction: row.correction,
      evidence: row.evidence,
      reviewerUserId: row.reviewerUserId,
      producedByRealModel: row.producedByRealModel,
      evaluationEligible: row.evaluationEligible,
      evaluationReason: row.evaluationReason,
      promotedCaseId: row.promotedCaseId,
      promotedAt: row.promotedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
