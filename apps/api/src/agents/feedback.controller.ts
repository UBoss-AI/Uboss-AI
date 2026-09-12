import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import {
  FEEDBACK_RATINGS,
  FEEDBACK_RATING_DESCRIPTIONS,
  FEEDBACK_RATING_LABELS,
  MIN_CORRECTION_LENGTH,
  type FeedbackRating,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { FeedbackService } from './feedback.service.js';

class SubmitFeedbackDto {
  @IsIn(FEEDBACK_RATINGS as readonly string[], {
    message: `rating must be one of: ${FEEDBACK_RATINGS.join(', ')}.`,
  })
  rating!: FeedbackRating;

  /**
   * Required for every rating but `Correct` — enforced by the service, not here, because the
   * requirement depends on the rating and a DTO cannot express "required when".
   */
  @IsOptional() @IsString() @MaxLength(4000) correction?: string;

  @IsOptional() @IsString() @MaxLength(4000) evidence?: string;
}

class PromoteFeedbackDto {
  @IsUUID(7) skillVersionId!: string;
  @IsString() @MinLength(4) @MaxLength(160) name!: string;
}

class QualityQueryDto {
  @IsOptional() @IsUUID(7) engineAgentId?: string;
}

/**
 * AI output feedback — Prompt 33.
 *
 * ## Two grants, on purpose
 *
 * Rating an output is `agents:Comment`, which an Employee holds: the person who did the work is
 * usually the one who can tell whether the AI got it right, and requiring a manager's grant would
 * silence the best-placed reviewer. Turning a rating into a regression case is
 * `settings:Administer` — the gate Prompt 17 uses for every change to a company Skill — because
 * that case will fail somebody's release in six months.
 *
 * ## What the meta route is for
 *
 * It carries `FEEDBACK_TRAINING_STANCE` — the product's statement that feedback never leaves
 * UBoss as training data. Prompt 33's instruction is not to *assume or automatically enable*
 * provider training, and the strongest form of that is a product where there is nothing to
 * disable and the screen says so.
 */
@Controller('tenants/:tenantId/feedback')
@TenantScoped()
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('meta')
  @RequirePermission({ module: 'agents', action: 'View' })
  meta(): Record<string, unknown> {
    return {
      ...this.feedback.meta(),
      ratings: FEEDBACK_RATINGS.map((rating) => ({
        rating,
        label: FEEDBACK_RATING_LABELS[rating],
        description: FEEDBACK_RATING_DESCRIPTIONS[rating],
        requiresCorrection: rating !== 'Correct',
      })),
      minCorrectionLength: MIN_CORRECTION_LENGTH,
    };
  }

  @Get('runs/:runId')
  @RequirePermission({ module: 'agents', action: 'View' })
  async listForRun(@Param('runId') runId: string): Promise<unknown> {
    return {
      feedback: await this.feedback.listForRun({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        runId,
      }),
    };
  }

  @Post('runs/:runId')
  @RequirePermission({ module: 'agents', action: 'Comment' })
  async submit(@Param('runId') runId: string, @Body() body: SubmitFeedbackDto): Promise<unknown> {
    return this.feedback.submit({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      runId,
      rating: body.rating,
      ...(body.correction === undefined ? {} : { correction: body.correction }),
      ...(body.evidence === undefined ? {} : { evidence: body.evidence }),
    });
  }

  /** Amend your own rating. Somebody else's judgement is theirs to change. */
  @Patch(':feedbackId')
  @RequirePermission({ module: 'agents', action: 'Comment' })
  async amend(
    @Param('feedbackId') feedbackId: string,
    @Body() body: SubmitFeedbackDto,
  ): Promise<unknown> {
    return this.feedback.amend({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      feedbackId,
      rating: body.rating,
      ...(body.correction === undefined ? {} : { correction: body.correction }),
      ...(body.evidence === undefined ? {} : { evidence: body.evidence }),
    });
  }

  @Get('quality')
  @RequirePermission({ module: 'agents', action: 'View' })
  async quality(@Query() query: QualityQueryDto): Promise<unknown> {
    return this.feedback.quality({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.engineAgentId === undefined ? {} : { engineAgentId: query.engineAgentId }),
    });
  }

  /**
   * Turn feedback into an evaluation case.
   *
   * `settings:Administer`, the same gate as every other change to a company Skill. The case
   * lands in the Prompt 18 tables, so the Skill's existing regression machinery picks it up — no
   * second dataset.
   */
  @Post(':feedbackId/promote')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async promote(
    @Param('feedbackId') feedbackId: string,
    @Body() body: PromoteFeedbackDto,
  ): Promise<unknown> {
    return this.feedback.promote({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      feedbackId,
      skillVersionId: body.skillVersionId,
      name: body.name,
    });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Feedback is for signed-in company members.');
    }
    return id;
  }
}
