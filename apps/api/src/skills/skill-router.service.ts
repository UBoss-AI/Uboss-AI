import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  ALLOWED_CANDIDATE_TRANSITIONS,
  compareVersions,
  evaluateOutput,
  mayTransitionCandidate,
  routeSkills,
  type CandidateStatus,
  type CaseOutcome,
  type EvaluationAssertion,
  type RegressionVerdict,
  type RoutableSkillVersion,
  type SkillContent,
  type SkillRouterContext,
  type SkillRoutingResult,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { SkillService } from './skill.service.js';

export interface RoutingOutcome extends SkillRoutingResult {
  /** Set when nothing applied and a Candidate was raised. */
  candidateId: string | null;
}

/**
 * The Skill Router, the evaluation harness and Skill Candidates.
 *
 * ## Two client rules are absolute here
 *
 * 1. **Only a published version is ever selected.** The candidate query filters on
 *    `status: 'Published'` and `scoreSkillForContext` disqualifies anything else — belt and
 *    brace, because a draft reaching production once is a draft nobody goes back to review.
 * 2. **A missing capability is recorded, never improvised.** When nothing applies, `route`
 *    raises a `SkillCandidate` carrying the context and every rejection, and routes it to
 *    governance. It does not publish, does not use a draft, and does not return a "best guess"
 *    for the caller to use anyway.
 *
 * ## The selection is a rules engine, and that is a decision rather than a gap
 *
 * There is no model. The router reasons over what a Skill **declares about itself** — the fields
 * Prompt 17 made mandatory exist precisely so a capability can be chosen without guessing.
 *
 * A selection that cannot be explained cannot be governed. Somebody will ask "why did an agent
 * use *that* Skill on our tender", and "the embedding was close" is not an answer a company can
 * act on. So every match carries its reasons, every rejection carries the one rule that ruled it
 * out, and the whole decision is reproducible from its inputs.
 *
 * ## The evaluation harness records; it does not run
 *
 * Running a Skill needs the Model Gateway (a later prompt). So a run's output is **supplied** —
 * by an operator or a test — and `producedBy` says so. A stub evaluator inventing plausible
 * output would make every green regression comparison worthless, and a comparison is exactly the
 * evidence somebody publishes on.
 */
@Injectable()
export class SkillRouterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly skills: SkillService,
  ) {}

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * Choose the approved Skills that apply, or raise a Candidate.
   *
   * `raiseCandidateIfMissing` defaults to **true**: the client's rule is that a missing capability
   * is routed to governance, and making that opt-in would mean the common path silently dropped
   * it. A caller exploring options can turn it off.
   */
  async route(input: {
    scope: TenantScope;
    actorUserId: string;
    context: SkillRouterContext;
    raiseCandidateIfMissing?: boolean | undefined;
  }): Promise<RoutingOutcome> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // `agents:Run` — routing is part of doing AI work, not part of administering Skills. An
    // employee who may run an approved agent must be able to find out which Skills apply.
    await this.authorization.assertCan(context, { module: 'agents', action: 'Run' });

    if (input.context.aiTask.trim() === '') {
      throw new BadRequestException(
        'The router needs to know what the work is. With no task there is nothing to match ' +
          'against what each Skill says it is for.',
      );
    }

    const candidates = await this.publishedCandidates(input.scope, input.context);
    const result = routeSkills(input.context, candidates);

    let candidateId: string | null = null;

    if (result.capabilityMissing && (input.raiseCandidateIfMissing ?? true)) {
      candidateId = await this.raiseCandidate({
        scope: input.scope,
        actorUserId: input.actorUserId,
        context: input.context,
        rejected: result.rejected,
      });
    }

    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: result.capabilityMissing ? 'skill.routing_found_nothing' : 'skill.routed',
        resourceType: 'skill_routing',
        actorUserId: input.actorUserId,
        summary: result.capabilityMissing
          ? 'No approved Skill applied to this work.'
          : `${result.matches.length} approved Skill(s) selected.`,
        metadata: {
          aiTask: input.context.aiTask.slice(0, 300),
          ...(input.context.departmentId === undefined
            ? {}
            : { departmentId: input.context.departmentId }),
          ...(input.context.objectiveId === undefined
            ? {}
            : { objectiveId: input.context.objectiveId }),
          consideredCount: candidates.length,
          selectedCount: result.matches.length,
          rejectedCount: result.rejected.length,
          topVersionId: result.matches[0]?.skillVersionId ?? null,
          topConfidence: result.matches[0]?.confidence ?? null,
          candidateRaised: candidateId,
          // Stated in the trail: nothing unapproved was even a candidate.
          onlyPublishedConsidered: true,
        },
      }),
    );

    return { ...result, candidateId };
  }

  /**
   * Every published version this company may use, as the router needs them.
   *
   * **The filter is the first of the two guarantees.** RLS already limits the rows to this
   * company's plus the platform's; `status: 'Published'` limits them to what has been approved.
   * A draft is not in the candidate set at all, so no scoring decision can reach one.
   */
  private async publishedCandidates(
    scope: TenantScope,
    context: SkillRouterContext,
  ): Promise<RoutableSkillVersion[]> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const versions = await this.prisma.client.skillVersion.findMany({
        where: {
          status: 'Published',
          ...(context.category === undefined ? {} : { category: context.category }),
        },
        include: { skill: true },
      });

      return versions.map((version) => ({
        skillId: version.skillId,
        skillVersionId: version.id,
        skillKey: version.skill.key,
        skillName: version.skill.name,
        layer: version.skill.layer,
        industry: version.skill.industry,
        status: version.status,
        category: version.category,
        purpose: version.purpose,
        whenToUse: version.whenToUse,
        whenNotToUse: version.whenNotToUse,
        declaredInputs: (version.inputs as { name: string; required: boolean }[]) ?? [],
        allowedToolCategories: [...version.allowedToolCategories],
        requiresApproval: version.requiresApproval,
        autonomy: version.autonomy,
        outputSchema: version.outputSchema,
      }));
    });
  }

  // -------------------------------------------------------------------------
  // Skill Candidates
  // -------------------------------------------------------------------------

  /**
   * Record a missing capability for governance.
   *
   * Deduplicated on the requested capability while an earlier request is still open: forty people
   * hitting the same gap should produce one thing for a reviewer to decide, not forty.
   */
  private async raiseCandidate(input: {
    scope: TenantScope;
    actorUserId: string;
    context: SkillRouterContext;
    rejected: SkillRoutingResult['rejected'];
  }): Promise<string> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const open = await this.prisma.client.skillCandidate.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          status: { in: ['Suggested', 'UnderReview'] },
          requestedCapability: input.context.aiTask.trim(),
        },
      });
      if (open) {
        return open.id;
      }

      const created = await this.prisma.client.skillCandidate.create({
        data: {
          tenantId: input.scope.tenantId,
          status: 'Suggested',
          requestedCapability: input.context.aiTask.trim(),
          routingContext: input.context as never,
          consideredAndRejected: input.rejected as never,
          requestedByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.candidate_raised',
        resourceType: 'skill_candidate',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary: 'A capability was needed and no approved Skill applied.',
        metadata: {
          requestedCapability: input.context.aiTask.slice(0, 300),
          consideredAndRejected: input.rejected.length,
          // The client's rule, on the record: nothing was published and nothing was auto-used.
          nothingPublished: true,
          nothingAutoUsed: true,
        },
      });

      return created.id;
    });
  }

  /** The governance queue: what capabilities people have needed and nobody has decided. */
  async listCandidates(input: {
    scope: TenantScope;
    actorUserId: string;
    status?: CandidateStatus | undefined;
  }): Promise<{
    candidates: {
      id: string;
      status: CandidateStatus;
      requestedCapability: string;
      suggestedName: string | null;
      consideredAndRejected: number;
      createdSkillId: string | null;
      decisionReason: string | null;
      requestedByUserId: string | null;
      createdAt: string;
      nextStatuses: CandidateStatus[];
    }[];
    note: string;
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.skillCandidate.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      return {
        candidates: rows.map((row) => ({
          id: row.id,
          status: row.status,
          requestedCapability: row.requestedCapability,
          suggestedName: row.suggestedName,
          consideredAndRejected: Array.isArray(row.consideredAndRejected)
            ? row.consideredAndRejected.length
            : 0,
          createdSkillId: row.createdSkillId,
          decisionReason: row.decisionReason,
          requestedByUserId: row.requestedByUserId,
          createdAt: row.createdAt.toISOString(),
          // From the shared table, so a screen offers exactly the moves the service accepts.
          // A local copy here is the drift this codebase has already had to remove once.
          nextStatuses: [...ALLOWED_CANDIDATE_TRANSITIONS[row.status]],
        })),
        note:
          'A Candidate is a request, not a capability. Accepting one creates a **draft** Skill ' +
          'that then goes through the normal lifecycle — there is no path from here to published, ' +
          'and nothing has been auto-used.',
      };
    });
  }

  /**
   * Accept a Candidate, which creates a **Draft** Skill.
   *
   * The only thing acceptance produces. The draft then goes through Draft → Test → Review →
   * Approved → Published like anything else, so a capability that arrived as a gap gets the same
   * scrutiny as one somebody planned.
   */
  async acceptCandidate(input: {
    scope: TenantScope;
    actorUserId: string;
    candidateId: string;
    key: string;
    name: string;
    content: SkillContent;
    reason: string;
  }): Promise<{ candidateId: string; skillId: string; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (!input.reason.trim()) {
      throw new BadRequestException(
        'Accepting a Candidate needs a reason: somebody has to say why a new capability is ' +
          'warranted, and that reasoning is what a later reviewer reads.',
      );
    }

    const candidate = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.skillCandidate.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.candidateId },
      }),
    );
    if (!candidate) {
      throw new NotFoundException('There is no such Skill Candidate.');
    }
    if (!mayTransitionCandidate(candidate.status, 'Accepted')) {
      throw new ConflictException(
        `A ${candidate.status} Candidate cannot be accepted. Accepted and Rejected are both ` +
          'final — a re-openable Candidate would be a second, weaker lifecycle beside the real ' +
          'one.',
      );
    }

    // The Skill is created **first**, through the service that owns the lifecycle, so it gets the
    // same validation, the same governance checks and the same audit event as any other draft.
    // Reimplementing creation here would eventually diverge from it.
    const skill = await this.skills.createCompanySkill({
      scope: input.scope,
      actorUserId: input.actorUserId,
      key: input.key,
      name: input.name,
      content: input.content,
      creationMode: 'Manual',
    });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.prisma.client.skillCandidate.update({
        where: { id: candidate.id },
        data: {
          status: 'Accepted',
          createdSkillId: skill.id,
          reviewedByUserId: input.actorUserId,
          reviewedAt: new Date(),
          decisionReason: input.reason.trim(),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.candidate_accepted',
        resourceType: 'skill_candidate',
        resourceId: candidate.id,
        actorUserId: input.actorUserId,
        summary: `Accepted — a draft Skill "${skill.name}" was created.`,
        reason: input.reason.trim(),
        metadata: {
          createdSkillId: skill.id,
          // Stated: acceptance produced a **draft**. Nothing is live.
          createdAs: 'Draft',
          requiresApprovalBeforeUse: true,
        },
      });

      return {
        candidateId: candidate.id,
        skillId: skill.id,
        note:
          'A draft Skill was created. It must go through Review and Approval before anything can ' +
          'use it — accepting a Candidate decides that a capability is wanted, not that this ' +
          'version of it is correct.',
      };
    });
  }

  /** Reject a Candidate, or move it under review. Both need a reason at the decision. */
  async decideCandidate(input: {
    scope: TenantScope;
    actorUserId: string;
    candidateId: string;
    to: Exclude<CandidateStatus, 'Accepted'>;
    reason?: string | undefined;
  }): Promise<{ status: CandidateStatus }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const candidate = await this.prisma.client.skillCandidate.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.candidateId },
      });
      if (!candidate) {
        throw new NotFoundException('There is no such Skill Candidate.');
      }
      if (!mayTransitionCandidate(candidate.status, input.to)) {
        throw new ConflictException(`A ${candidate.status} Candidate cannot become ${input.to}.`);
      }

      if (input.to === 'Rejected' && !input.reason?.trim()) {
        throw new BadRequestException(
          'Rejecting a Candidate needs a reason. Somebody asked for a capability and did not ' +
            'get it; they are owed an explanation, and the next person to hit the same gap will ' +
            'read it.',
        );
      }

      const at = new Date();
      const updated = await this.prisma.client.skillCandidate.update({
        where: { id: candidate.id },
        data: {
          status: input.to,
          ...(input.to === 'Rejected'
            ? {
                reviewedByUserId: input.actorUserId,
                reviewedAt: at,
                decisionReason: input.reason?.trim() ?? '',
              }
            : {}),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: `skill.candidate_${input.to.toLowerCase()}`,
        resourceType: 'skill_candidate',
        resourceId: candidate.id,
        actorUserId: input.actorUserId,
        summary: `Skill Candidate: ${candidate.status} → ${input.to}.`,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        metadata: { from: candidate.status, to: input.to },
      });

      return { status: updated.status };
    });
  }

  // -------------------------------------------------------------------------
  // Evaluation cases
  // -------------------------------------------------------------------------

  /**
   * Save a case against a Skill.
   *
   * Attached to the **Skill**, not a version, so the same case can be run against the live
   * version and a candidate — which is the whole point of a regression comparison.
   */
  async addCase(input: {
    scope: TenantScope;
    actorUserId: string;
    skillId: string;
    name: string;
    description: string;
    inputs: Record<string, unknown>;
    assertion: EvaluationAssertion;
    expected: string;
  }): Promise<{ id: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const skill = await this.prisma.client.skill.findFirst({ where: { id: input.skillId } });
      if (!skill) {
        throw new NotFoundException('There is no such Skill.');
      }
      if (skill.tenantId !== input.scope.tenantId) {
        throw new ConflictException(
          'That Skill is published by UBoss, so its evaluation cases are part of what UBoss ' +
            'maintains. Clone it to keep your own cases against your own version.',
        );
      }

      const existing = await this.prisma.client.skillEvaluationCase.findFirst({
        where: { skillId: skill.id, name: input.name.trim() },
      });
      if (existing) {
        throw new ConflictException(`That Skill already has a case called "${input.name}".`);
      }

      const created = await this.prisma.client.skillEvaluationCase.create({
        data: {
          tenantId: input.scope.tenantId,
          skillId: skill.id,
          name: input.name.trim(),
          description: input.description.trim(),
          inputs: input.inputs as never,
          assertion: input.assertion,
          expected: input.expected,
          createdByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.evaluation_case_added',
        resourceType: 'skill_evaluation_case',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary: `Saved evaluation case "${created.name}".`,
        metadata: { skillId: skill.id, assertion: input.assertion },
      });

      return { id: created.id };
    });
  }

  /** Every case for a Skill, with how many times each has been run. */
  async listCases(input: { scope: TenantScope; actorUserId: string; skillId: string }): Promise<{
    cases: {
      id: string;
      name: string;
      description: string;
      assertion: EvaluationAssertion;
      expected: string;
      /** Frozen once a comparison has depended on it. */
      expectationFrozen: boolean;
      retired: boolean;
      runCount: number;
    }[];
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.skillEvaluationCase.findMany({
        where: { skillId: input.skillId },
        include: { _count: { select: { runs: true } } },
        orderBy: { name: 'asc' },
      });

      return {
        cases: rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          assertion: row.assertion,
          expected: row.expected,
          expectationFrozen: row.usedInComparison,
          retired: row.retiredAt !== null,
          runCount: row._count.runs,
        })),
      };
    });
  }

  /**
   * Record what a Skill version returned for a case, and what that means.
   *
   * **The output is supplied, not produced.** There is no evaluator: running a Skill needs the
   * Model Gateway. `producedBy` defaults to `Recorded`, and every layer says so — a stub that
   * invented output would make every green comparison worthless.
   *
   * The verdict is computed by `evaluateOutput` for the two computable assertions. A
   * `HumanJudged` case needs `passed` supplied; without it the run is stored **unjudged**, which
   * counts as neither pass nor fail so no comparison can lean on it.
   */
  async recordRun(input: {
    scope: TenantScope;
    actorUserId: string;
    caseId: string;
    skillVersionId: string;
    actualOutput: string;
    /** Required for a `HumanJudged` case; ignored otherwise. */
    passed?: boolean | undefined;
    note?: string | undefined;
    durationMs?: number | undefined;
  }): Promise<{ id: string; passed: boolean | null; computed: boolean }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const evaluationCase = await this.prisma.client.skillEvaluationCase.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.caseId },
      });
      if (!evaluationCase) {
        throw new NotFoundException('There is no such evaluation case.');
      }
      if (evaluationCase.retiredAt !== null) {
        throw new ConflictException(
          'That case is retired. Its previous runs are kept, but it takes no new ones.',
        );
      }

      const version = await this.prisma.client.skillVersion.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.skillVersionId },
      });
      if (!version) {
        throw new NotFoundException('There is no such Skill version.');
      }
      if (version.skillId !== evaluationCase.skillId) {
        throw new BadRequestException(
          'That case belongs to a different Skill. A case is written against one capability, so ' +
            'running it elsewhere would produce a verdict about nothing.',
        );
      }

      const computed = evaluateOutput({
        assertion: evaluationCase.assertion,
        expected: evaluationCase.expected,
        actual: input.actualOutput,
      });

      // `HumanJudged` cannot be computed. A supplied verdict is used; otherwise the run stays
      // unjudged rather than defaulting to a pass.
      const passed = computed === null ? (input.passed ?? null) : computed;

      if (computed === null && input.passed !== undefined && !input.note?.trim()) {
        throw new BadRequestException(
          'A judged case needs a note saying what the judgement was based on. A verdict with no ' +
            'reasoning is not evidence anybody can review.',
        );
      }

      const created = await this.prisma.client.skillEvaluationRun.create({
        data: {
          tenantId: input.scope.tenantId,
          caseId: evaluationCase.id,
          skillVersionId: version.id,
          actualOutput: input.actualOutput,
          passed,
          producedBy: 'Recorded',
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
          runByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.evaluation_run_recorded',
        resourceType: 'skill_evaluation_run',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary:
          `Case "${evaluationCase.name}" on version ${version.versionNumber}: ` +
          `${passed === null ? 'unjudged' : passed ? 'passed' : 'failed'}.`,
        metadata: {
          caseId: evaluationCase.id,
          skillVersionId: version.id,
          assertion: evaluationCase.assertion,
          verdictComputed: computed !== null,
          // The distinction the whole harness design preserves.
          producedBy: 'Recorded',
          note: 'No evaluator exists yet; the output was supplied rather than generated.',
        },
      });

      return { id: created.id, passed, computed: computed !== null };
    });
  }

  // -------------------------------------------------------------------------
  // Regression comparison
  // -------------------------------------------------------------------------

  /**
   * Compare a candidate version against the live one, case by case.
   *
   * Uses the **latest run** of each case against each version. A case with no run against one of
   * the two is `unjudged`, and cannot contribute to the verdict — so a comparison of a version
   * nobody has evaluated is `Inconclusive` rather than `NoChange`.
   *
   * Every case the comparison depended on is marked `usedInComparison`, which freezes its
   * expectation: a case whose expectation could be edited after a comparison is evidence that can
   * be made to agree with whatever happened.
   */
  async compare(input: {
    scope: TenantScope;
    actorUserId: string;
    candidateVersionId: string;
  }): Promise<{
    id: string;
    verdict: RegressionVerdict;
    casesCompared: number;
    regressions: number;
    improvements: number;
    unjudged: number;
    blocksPublication: boolean;
    note: string;
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const candidate = await this.prisma.client.skillVersion.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.candidateVersionId },
      });
      if (!candidate) {
        throw new NotFoundException('There is no such Skill version.');
      }

      const live = await this.prisma.client.skillVersion.findFirst({
        where: { skillId: candidate.skillId, status: 'Published' },
      });

      if (live?.id === candidate.id) {
        throw new BadRequestException(
          'That version is already the published one. A comparison needs two versions.',
        );
      }

      const cases = await this.prisma.client.skillEvaluationCase.findMany({
        where: { skillId: candidate.skillId, retiredAt: null },
      });

      const outcomes: CaseOutcome[] = [];
      for (const evaluationCase of cases) {
        const [currentRun, candidateRun] = await Promise.all([
          live === null
            ? null
            : this.prisma.client.skillEvaluationRun.findFirst({
                where: { caseId: evaluationCase.id, skillVersionId: live.id },
                orderBy: { runAt: 'desc' },
              }),
          this.prisma.client.skillEvaluationRun.findFirst({
            where: { caseId: evaluationCase.id, skillVersionId: candidate.id },
            orderBy: { runAt: 'desc' },
          }),
        ]);

        outcomes.push({
          caseId: evaluationCase.id,
          currentPassed: currentRun?.passed ?? null,
          candidatePassed: candidateRun?.passed ?? null,
        });
      }

      const comparison = compareVersions(outcomes);

      const created = await this.prisma.client.skillRegressionComparison.create({
        data: {
          tenantId: input.scope.tenantId,
          skillId: candidate.skillId,
          ...(live === null ? {} : { currentVersionId: live.id }),
          candidateVersionId: candidate.id,
          casesCompared: comparison.casesCompared,
          regressions: comparison.regressions,
          improvements: comparison.improvements,
          unjudged: comparison.unjudged,
          verdict: comparison.verdict,
          runByUserId: input.actorUserId,
        },
      });

      // Freeze the expectations the comparison depended on.
      const dependedOn = outcomes
        .filter((outcome) => !comparison.unjudged.includes(outcome.caseId))
        .map((outcome) => outcome.caseId);
      if (dependedOn.length > 0) {
        await this.prisma.client.skillEvaluationCase.updateMany({
          where: { id: { in: dependedOn } },
          data: { usedInComparison: true },
        });
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.regression_compared',
        resourceType: 'skill_regression_comparison',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary: `Version ${candidate.versionNumber} against the live version: ${comparison.verdict}.`,
        metadata: {
          skillId: candidate.skillId,
          candidateVersionId: candidate.id,
          currentVersionId: live?.id ?? null,
          verdict: comparison.verdict,
          casesCompared: comparison.casesCompared,
          regressions: comparison.regressions.length,
          improvements: comparison.improvements.length,
          unjudged: comparison.unjudged.length,
        },
      });

      return {
        id: created.id,
        verdict: comparison.verdict,
        casesCompared: comparison.casesCompared,
        regressions: comparison.regressions.length,
        improvements: comparison.improvements.length,
        unjudged: comparison.unjudged.length,
        // The finding somebody publishing needs to see on its own.
        blocksPublication: comparison.verdict === 'Regressed' || comparison.verdict === 'Mixed',
        note: this.comparisonNote(comparison.verdict, comparison.unjudged.length),
      };
    });
  }

  /** Record that somebody published over a regression, deliberately and with a reason. */
  async acceptRegression(input: {
    scope: TenantScope;
    actorUserId: string;
    comparisonId: string;
    reason: string;
  }): Promise<{ accepted: true }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.reason.trim().length < 10) {
      throw new BadRequestException(
        'Publishing over a regression needs a real reason: something that used to work will stop ' +
          'working, and the person who finds that out will read this.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const comparison = await this.prisma.client.skillRegressionComparison.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.comparisonId },
      });
      if (!comparison) {
        throw new NotFoundException('There is no such comparison.');
      }
      if (comparison.regressions.length === 0) {
        throw new BadRequestException(
          'That comparison found no regression, so there is nothing to accept.',
        );
      }

      await this.prisma.client.skillRegressionComparison.update({
        where: { id: comparison.id },
        data: {
          acceptedDespiteRegressionByUserId: input.actorUserId,
          acceptedDespiteRegressionAt: new Date(),
          acceptanceReason: input.reason.trim(),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.regression_accepted',
        resourceType: 'skill_regression_comparison',
        resourceId: comparison.id,
        actorUserId: input.actorUserId,
        summary: `${comparison.regressions.length} regression(s) accepted deliberately.`,
        reason: input.reason.trim(),
        metadata: {
          skillId: comparison.skillId,
          candidateVersionId: comparison.candidateVersionId,
          regressions: comparison.regressions.length,
        },
      });

      return { accepted: true };
    });
  }

  /** Every comparison for a Skill, newest first. */
  async comparisonsFor(input: {
    scope: TenantScope;
    actorUserId: string;
    skillId: string;
  }): Promise<{
    comparisons: {
      id: string;
      verdict: RegressionVerdict;
      candidateVersionId: string;
      currentVersionId: string | null;
      casesCompared: number;
      regressions: number;
      improvements: number;
      unjudged: number;
      acceptedDespiteRegression: boolean;
      acceptanceReason: string | null;
      runAt: string;
    }[];
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.skillRegressionComparison.findMany({
        where: { skillId: input.skillId },
        orderBy: { runAt: 'desc' },
        take: 50,
      });

      return {
        comparisons: rows.map((row) => ({
          id: row.id,
          verdict: row.verdict,
          candidateVersionId: row.candidateVersionId,
          currentVersionId: row.currentVersionId,
          casesCompared: row.casesCompared,
          regressions: row.regressions.length,
          improvements: row.improvements.length,
          unjudged: row.unjudged.length,
          acceptedDespiteRegression: row.acceptedDespiteRegressionAt !== null,
          acceptanceReason: row.acceptanceReason,
          runAt: row.runAt.toISOString(),
        })),
      };
    });
  }

  private comparisonNote(verdict: RegressionVerdict, unjudged: number): string {
    const tail =
      unjudged === 0
        ? ''
        : ` ${unjudged} case(s) could not be judged and did not count towards this — an ` +
          'unjudged case is neither a pass nor a failure, so a verdict cannot lean on it.';

    switch (verdict) {
      case 'Regressed':
        return (
          'Something the live version passes, this one fails. That is a blocker until somebody ' +
          'accepts it deliberately and says why.' +
          tail
        );
      case 'Mixed':
        return (
          'Some cases improved and some regressed. The regression is still a blocker: "eight ' +
          'better, one worse" is a decision somebody has to make, not a pass.' +
          tail
        );
      case 'Improved':
        return 'The candidate passes everything the live version passes, and more.' + tail;
      case 'NoChange':
        return 'Identical results on every case that could be compared.' + tail;
      default:
        return (
          'Nothing could be compared. Record runs of the same cases against both versions ' +
          'first — a comparison with no evidence is not a green light.' +
          tail
        );
    }
  }
}
