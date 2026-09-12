import { Body, Controller, Get, Param, Post, UnauthorizedException } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import {
  OUTCOME_VERDICTS,
  PAUSE_REASONS,
  type OutcomeVerdict,
  type PauseReason,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { ObjectiveClosureService } from './objective-closure.service.js';

class PauseDto {
  @IsIn(PAUSE_REASONS as readonly string[], {
    message: `reasonKind must be one of: ${PAUSE_REASONS.join(', ')}.`,
  })
  reasonKind!: PauseReason;

  @IsString() @MinLength(4) @MaxLength(1000) reason!: string;
}

class ResumeDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class ReviewDto {
  @IsIn(OUTCOME_VERDICTS as readonly string[], {
    message: `verdict must be one of: ${OUTCOME_VERDICTS.join(', ')}.`,
  })
  verdict!: OutcomeVerdict;

  @IsString() @MinLength(10) @MaxLength(4000) actualResult!: string;

  /**
   * Required for every verdict but `Met`, enforced by the service rather than here: the
   * requirement depends on the verdict and a DTO cannot express "required when".
   */
  @IsOptional() @IsString() @MaxLength(4000) explanation?: string;
}

class CloseDto {
  /** A verified approved request, where the company's policy requires one. */
  @IsOptional() @IsUUID(7) approvalRequestId?: string;
}

/**
 * Objective closure — Prompt 34.
 *
 * ## Four grants across six acts, and why they differ
 *
 * * **Pause and resume** — `objective:Publish`. Authority over live work is one authority: the
 *   grant that put the objective live is the grant that may stop it. Deliberately **not**
 *   `objective:Pause`, which reads better and is held by nobody — the role templates grant
 *   `Pause` on `agents` only, so that route would have been a 403 for every user in every
 *   company.
 * * **Complete and archive** — `objective:Publish`. Declaring a company's work finished is the
 *   same weight of decision as declaring it started.
 * * **Review** — `objective:Approve`. Grading how work turned out is a judgement rather than an
 *   edit, and deliberately not the same grant as completing it: the person who declared the work
 *   finished should not be the only one who can grade it. A company that wants them to be the
 *   same person assigns both roles.
 * * **Sign off** — `objective:View`, because the service then checks the actor *is the owner*. A
 *   permission cannot express "the owner of this particular objective", so the grant is the low
 *   one and the identity check is the real control.
 * * **Close** — `objective:Publish`, plus whatever the review's own sign-off policy requires.
 *
 * ## There is no "reopen"
 *
 * Reopening work is `startNewDraft` on the authoring service, which is the versioning rule. A
 * `reopen` route here would be a second way to do it, and the one thing §27.1 is explicit about is
 * that a historical live version is never mutated.
 */
@Controller('tenants/:tenantId/objectives/:objectiveId/closure')
@TenantScoped()
export class ObjectiveClosureController {
  constructor(
    private readonly closure: ObjectiveClosureService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('meta')
  @RequirePermission({ module: 'objective', action: 'View' })
  async meta(): Promise<unknown> {
    return this.closure.meta({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
    });
  }

  /** The comparison and what is outstanding, before anybody signs anything. */
  @Get('readiness')
  @RequirePermission({ module: 'objective', action: 'View' })
  async readiness(@Param('objectiveId') objectiveId: string): Promise<unknown> {
    return this.closure.readiness({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
  }

  @Get('review')
  @RequirePermission({ module: 'objective', action: 'View' })
  async review(@Param('objectiveId') objectiveId: string): Promise<unknown> {
    return {
      review: await this.closure.reviewOf({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        objectiveId,
      }),
    };
  }

  @Get('pauses')
  @RequirePermission({ module: 'objective', action: 'View' })
  async pauses(@Param('objectiveId') objectiveId: string): Promise<unknown> {
    return {
      pauses: await this.closure.pauses({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        objectiveId,
      }),
    };
  }

  @Post('pause')
  @RequirePermission({ module: 'objective', action: 'Publish' })
  async pause(@Param('objectiveId') objectiveId: string, @Body() body: PauseDto): Promise<unknown> {
    return this.closure.pause({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      reasonKind: body.reasonKind,
      reason: body.reason,
    });
  }

  @Post('resume')
  @RequirePermission({ module: 'objective', action: 'Publish' })
  async resume(
    @Param('objectiveId') objectiveId: string,
    @Body() body: ResumeDto,
  ): Promise<unknown> {
    return this.closure.resume({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
  }

  @Post('complete')
  @RequirePermission({ module: 'objective', action: 'Publish' })
  async complete(@Param('objectiveId') objectiveId: string): Promise<unknown> {
    return this.closure.complete({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
  }

  @Post('review')
  @RequirePermission({ module: 'objective', action: 'Approve' })
  async writeReview(
    @Param('objectiveId') objectiveId: string,
    @Body() body: ReviewDto,
  ): Promise<unknown> {
    return this.closure.review({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      verdict: body.verdict,
      actualResult: body.actualResult,
      ...(body.explanation === undefined ? {} : { explanation: body.explanation }),
    });
  }

  /**
   * Sign the review off as the objective's owner.
   *
   * `View` at the route, and the service then requires the actor to *be* the owner — a permission
   * cannot express "the owner of this particular objective", so the identity check is where the
   * control lives.
   */
  @Post('sign-off')
  @RequirePermission({ module: 'objective', action: 'View' })
  async signOff(@Param('objectiveId') objectiveId: string): Promise<unknown> {
    return this.closure.signOff({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
  }

  @Post('close')
  @RequirePermission({ module: 'objective', action: 'Publish' })
  async close(@Param('objectiveId') objectiveId: string, @Body() body: CloseDto): Promise<unknown> {
    return this.closure.close({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.approvalRequestId === undefined
        ? {}
        : { approvalRequestId: body.approvalRequestId }),
    });
  }

  @Post('archive')
  @RequirePermission({ module: 'objective', action: 'Publish' })
  async archive(@Param('objectiveId') objectiveId: string): Promise<unknown> {
    return this.closure.archive({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Objective closure is for signed-in company members.');
    }
    return id;
  }
}
