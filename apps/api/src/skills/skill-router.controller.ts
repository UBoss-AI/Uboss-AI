import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  CANDIDATE_STATUS_LABELS,
  CANDIDATE_STATUSES,
  EVALUATION_ASSERTION_LABELS,
  EVALUATION_ASSERTIONS,
  REGRESSION_VERDICTS,
  ROUTER_MAX_RESULTS,
  ROUTER_MIN_CONFIDENCE,
  SKILL_AUTONOMY_LEVELS,
  SKILL_CATEGORIES,
  TOOL_ACTION_CATEGORIES,
  type CandidateStatus,
  type EvaluationAssertion,
  type SkillAutonomy,
  type SkillCategory,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { SkillContentDto } from './skill.controller.js';
import { SkillRouterService } from './skill-router.service.js';

export class RouteDto {
  @IsOptional() @IsUUID() objectiveId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsString() @MaxLength(80) industry?: string;

  @IsString() @MinLength(3) @MaxLength(2000) aiTask!: string;

  @IsArray() @IsString({ each: true }) availableInputs!: string[];
  @IsOptional() @IsString() @MaxLength(2000) requiredOutput?: string;

  @IsArray() @IsIn(TOOL_ACTION_CATEGORIES, { each: true }) allowedToolCategories!: string[];

  @IsBoolean() requiresApproval!: boolean;

  /** The company's ceiling. A Skill above it is disqualified, not ranked lower. */
  @IsOptional() @IsIn(SKILL_AUTONOMY_LEVELS) maxAutonomy?: SkillAutonomy;

  @IsOptional() @IsIn(SKILL_CATEGORIES) category?: SkillCategory;

  /** Off only for a caller exploring options. Defaults to raising one, per the client's rule. */
  @IsOptional() @IsBoolean() raiseCandidateIfMissing?: boolean;
}

export class AddCaseDto {
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsString() @MinLength(5) @MaxLength(1000) description!: string;

  /**
   * The named inputs this case supplies. `@Allow()` because the **values** are deliberately
   * untyped — a Skill's inputs are whatever it declares — and `whitelist: true` strips a property
   * with no validation decorator (the Prompt 9 lesson).
   */
  @Allow()
  inputs!: Record<string, unknown>;

  @IsIn(EVALUATION_ASSERTIONS) assertion!: EvaluationAssertion;
  @IsString() @MinLength(1) @MaxLength(8000) expected!: string;
}

export class RecordRunDto {
  @IsUUID() caseId!: string;
  @IsUUID() skillVersionId!: string;
  @IsString() @MaxLength(20000) actualOutput!: string;
  /** Required for a `HumanJudged` case; computed otherwise. */
  @IsOptional() @IsBoolean() passed?: boolean;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(1000) note?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) durationMs?: number;
}

export class AcceptCandidateDto {
  @IsString() @Matches(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/) @MaxLength(80) key!: string;
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsString() @MinLength(10) @MaxLength(1000) reason!: string;
  @ValidateNested() @Type(() => SkillContentDto) content!: SkillContentDto;
}

export class DecideCandidateDto {
  @IsIn(['UnderReview', 'Rejected']) to!: 'UnderReview' | 'Rejected';
  @IsOptional() @IsString() @MinLength(5) @MaxLength(1000) reason?: string;
}

export class AcceptRegressionDto {
  @IsString() @MinLength(10) @MaxLength(1000) reason!: string;
}

export class CandidateQueryDto {
  @IsOptional() @IsIn(CANDIDATE_STATUSES) status?: CandidateStatus;
}

/**
 * The Skill Router, saved evaluation cases and regression comparison.
 *
 * ## What no route here can do
 *
 * - **Return an unapproved Skill.** The router's candidate set is `status: 'Published'` and the
 *   scorer disqualifies anything else. There is no parameter to relax it.
 * - **Publish a missing capability.** The Candidate status enum has no `Published` member, so
 *   there is no value to set. Accepting a Candidate creates a **draft** that goes through the
 *   normal lifecycle.
 * - **Invent an evaluation result.** A run's output is supplied and `producedBy` records that it
 *   was recorded rather than generated. There is no evaluator until the Model Gateway exists.
 *
 * ## Routing is `agents:Run`, not `settings:Administer`
 *
 * Finding out which Skills apply to a piece of work is part of doing the work. An employee who
 * may run an approved agent must be able to ask; administering the catalogue is a different
 * permission on a different route.
 */
@Controller('tenants/:tenantId/skill-router')
@TenantScoped()
export class SkillRouterController {
  constructor(
    private readonly router: SkillRouterService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The router's own parameters, so a caller knows what "a small set" means. */
  @Get('meta')
  @RequirePermission({ module: 'agents', action: 'View' })
  meta(): unknown {
    return {
      maxResults: ROUTER_MAX_RESULTS,
      minConfidence: ROUTER_MIN_CONFIDENCE,
      assertions: EVALUATION_ASSERTIONS.map((assertion) => ({
        assertion,
        label: EVALUATION_ASSERTION_LABELS[assertion],
      })),
      verdicts: REGRESSION_VERDICTS,
      candidateStatuses: CANDIDATE_STATUSES.map((status) => ({
        status,
        label: CANDIDATE_STATUS_LABELS[status],
      })),
      note:
        'The router selects only published, approved Skill versions, returns at most ' +
        `${ROUTER_MAX_RESULTS} with reasons and a confidence, and lists every rejection with the ` +
        'rule that ruled it out. When nothing applies it raises a Skill Candidate for ' +
        'governance — it never publishes and never uses an unapproved version.',
    };
  }

  /** Select the Skills that apply, or raise a Candidate. */
  @Post('route')
  @RequirePermission({ module: 'agents', action: 'Run' })
  async route(@Body() body: RouteDto): Promise<unknown> {
    return this.router.route({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      context: {
        ...(body.objectiveId === undefined ? {} : { objectiveId: body.objectiveId }),
        ...(body.departmentId === undefined ? {} : { departmentId: body.departmentId }),
        ...(body.industry === undefined ? {} : { industry: body.industry }),
        aiTask: body.aiTask,
        availableInputs: body.availableInputs,
        ...(body.requiredOutput === undefined ? {} : { requiredOutput: body.requiredOutput }),
        allowedToolCategories: body.allowedToolCategories,
        requiresApproval: body.requiresApproval,
        ...(body.maxAutonomy === undefined ? {} : { maxAutonomy: body.maxAutonomy }),
        ...(body.category === undefined ? {} : { category: body.category }),
      },
      ...(body.raiseCandidateIfMissing === undefined
        ? {}
        : { raiseCandidateIfMissing: body.raiseCandidateIfMissing }),
    });
  }

  // ---- Candidates ----

  @Get('candidates')
  @RequirePermission({ module: 'settings', action: 'View' })
  async candidates(@Query() query: CandidateQueryDto): Promise<unknown> {
    return this.router.listCandidates({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
  }

  /** Accept a Candidate. Creates a **draft** Skill and nothing else. */
  @Post('candidates/:id/accept')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async acceptCandidate(
    @Param('id') id: string,
    @Body() body: AcceptCandidateDto,
  ): Promise<unknown> {
    return this.router.acceptCandidate({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      candidateId: id,
      key: body.key,
      name: body.name,
      content: body.content,
      reason: body.reason,
    });
  }

  @Post('candidates/:id/decide')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async decideCandidate(
    @Param('id') id: string,
    @Body() body: DecideCandidateDto,
  ): Promise<unknown> {
    return this.router.decideCandidate({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      candidateId: id,
      to: body.to,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  }

  // ---- Evaluation ----

  @Get('skills/:skillId/cases')
  @RequirePermission({ module: 'settings', action: 'View' })
  async cases(@Param('skillId') skillId: string): Promise<unknown> {
    return this.router.listCases({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      skillId,
    });
  }

  @Post('skills/:skillId/cases')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async addCase(@Param('skillId') skillId: string, @Body() body: AddCaseDto): Promise<unknown> {
    return this.router.addCase({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      skillId,
      name: body.name,
      description: body.description,
      inputs: body.inputs,
      assertion: body.assertion,
      expected: body.expected,
    });
  }

  /**
   * Record what a version returned for a case.
   *
   * The output is **supplied**, not generated: there is no evaluator until the Model Gateway
   * exists, and the response says which it was.
   */
  @Post('runs')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async recordRun(@Body() body: RecordRunDto): Promise<unknown> {
    const result = await this.router.recordRun({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      caseId: body.caseId,
      skillVersionId: body.skillVersionId,
      actualOutput: body.actualOutput,
      ...(body.passed === undefined ? {} : { passed: body.passed }),
      ...(body.note === undefined ? {} : { note: body.note }),
      ...(body.durationMs === undefined ? {} : { durationMs: body.durationMs }),
    });

    return {
      ...result,
      note: result.computed
        ? 'The verdict was computed from the assertion.'
        : 'This case is judged by a person, so the verdict is whatever was supplied — and if ' +
          'none was, the run is stored unjudged and cannot count towards a comparison.',
    };
  }

  // ---- Regression comparison ----

  @Post('versions/:versionId/compare')
  @RequirePermission({ module: 'settings', action: 'View' })
  async compare(@Param('versionId') versionId: string): Promise<unknown> {
    return this.router.compare({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      candidateVersionId: versionId,
    });
  }

  @Get('skills/:skillId/comparisons')
  @RequirePermission({ module: 'settings', action: 'View' })
  async comparisons(@Param('skillId') skillId: string): Promise<unknown> {
    return this.router.comparisonsFor({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      skillId,
    });
  }

  /** Record a deliberate decision to publish over a regression. */
  @Post('comparisons/:id/accept-regression')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async acceptRegression(
    @Param('id') id: string,
    @Body() body: AcceptRegressionDto,
  ): Promise<unknown> {
    return this.router.acceptRegression({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      comparisonId: id,
      reason: body.reason,
    });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
