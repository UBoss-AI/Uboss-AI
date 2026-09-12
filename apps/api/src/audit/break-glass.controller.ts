import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { BreakGlassService } from './break-glass.service.js';
import {
  ApproveBreakGlassDto,
  DenyBreakGlassDto,
  ListBreakGlassDto,
  NotifyCustomerDto,
  RequestBreakGlassDto,
  RevokeBreakGlassDto,
  VerifyBreakGlassIdentityDto,
} from './audit.dto.js';

/**
 * Break-glass recovery: the emergency path into a customer's company, and its paper trail.
 *
 * ## Why every route here is `@PlatformOnly`, permanently
 *
 * Unlike the other `@PlatformOnly` controllers in this codebase, this one is not waiting to be
 * re-homed. Break-glass is *platform staff requesting access into a customer's data*; a company
 * granting itself emergency access to its own data is not a concept. The nearest company-side
 * equivalent — a Company Admin recovering a locked-out user — is ordinary administration and
 * belongs elsewhere.
 *
 * ## The steps are separate endpoints on purpose
 *
 * Request, verify identity, approve, activate, revoke and notify are six calls, not one call
 * with a state parameter. Each is performed by a different person at a different time, and each
 * writes its own row to both trails. A single "create an approved grant" endpoint would make the
 * whole control a formality — and it is exactly the endpoint someone under pressure would ask
 * for.
 */
@Controller('platform/break-glass')
@PlatformOnly()
export class BreakGlassController {
  constructor(private readonly breakGlass: BreakGlassService) {}

  /** Raise a request. Grants nothing until verified, approved and activated. */
  @Post()
  async request(@Body() body: RequestBreakGlassDto): Promise<unknown> {
    const request = await this.breakGlass.request({
      tenantId: body.tenantId,
      requesterUserId: this.currentUserId(),
      reason: body.reason,
      externalReference: body.externalReference,
      allowedModules: body.allowedModules,
      allowedActions: body.allowedActions,
      allowedResourceIds: body.allowedResourceIds,
    });
    return serialise(request);
  }

  /**
   * Record the out-of-band identity check.
   *
   * The verifier is taken from the authenticated actor, not from the body: letting a caller
   * name the verifier would let the requester nominate themselves, which the service refuses
   * anyway — but the refusal should never be the only thing standing in the way.
   */
  @Post(':requestId/verify-identity')
  async verifyIdentity(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: VerifyBreakGlassIdentityDto,
  ): Promise<unknown> {
    const request = await this.breakGlass.verifyIdentity({
      requestId,
      verifierUserId: this.currentUserId(),
      result: body.result,
      note: body.note,
    });
    return serialise(request);
  }

  /** Approve, with a bounded window. Refused if the approver is the requester. */
  @Post(':requestId/approve')
  async approve(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: ApproveBreakGlassDto,
  ): Promise<unknown> {
    const request = await this.breakGlass.approve({
      requestId,
      approverUserId: this.currentUserId(),
      minutes: body.minutes,
      note: body.note,
    });
    return serialise(request);
  }

  @Post(':requestId/deny')
  async deny(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: DenyBreakGlassDto,
  ): Promise<unknown> {
    const request = await this.breakGlass.deny({
      requestId,
      approverUserId: this.currentUserId(),
      reason: body.reason,
    });
    return serialise(request);
  }

  /** Start the clock on an approved request. */
  @Post(':requestId/activate')
  async activate(@Param('requestId', new ParseUUIDPipe()) requestId: string): Promise<unknown> {
    const request = await this.breakGlass.activate({
      requestId,
      actorUserId: this.currentUserId(),
    });
    return serialise(request);
  }

  @Post(':requestId/revoke')
  async revoke(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: RevokeBreakGlassDto,
  ): Promise<unknown> {
    const request = await this.breakGlass.revoke({
      requestId,
      revokedByUserId: this.currentUserId(),
      reason: body.reason,
    });
    return serialise(request);
  }

  /** Record whether the customer was told, and if not, why not. */
  @Post(':requestId/customer-notification')
  async notifyCustomer(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() body: NotifyCustomerDto,
  ): Promise<unknown> {
    const request = await this.breakGlass.recordCustomerNotification({
      requestId,
      actorUserId: this.currentUserId(),
      outcome: body.outcome,
      suppressionReason: body.suppressionReason,
    });
    return serialise(request);
  }

  @Get()
  async list(@Query() query: ListBreakGlassDto): Promise<unknown> {
    const requests = await this.breakGlass.list({
      tenantId: query.tenantId,
      state: query.state,
      notificationPending: query.notificationPending === 'true',
      take: query.take,
    });
    return { requests: requests.map(serialise) };
  }

  @Get(':requestId')
  async findOne(@Param('requestId', new ParseUUIDPipe()) requestId: string): Promise<unknown> {
    return serialise(await this.breakGlass.findById(requestId));
  }

  /**
   * Move elapsed grants to `Expired`.
   *
   * Exposed as an endpoint so the state can be tidied before a scheduler exists. It is
   * reporting hygiene, not enforcement — `activeGrantFor` already refuses an elapsed grant, so
   * nothing depends on this having run.
   */
  @Post('expire-elapsed')
  async expireElapsed(): Promise<{ expired: number }> {
    return { expired: await this.breakGlass.expireElapsed() };
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException(
        'Break-glass steps must be attributable to a named person. A request, verification or ' +
          'approval with no identified actor is not a control.',
      );
    }
    return userId;
  }
}

/**
 * The API shape of a break-glass request.
 *
 * Written out field by field rather than returned raw, so adding a column to the table does not
 * silently publish it. The three list columns are returned as arrays and the notification state
 * is surfaced prominently, because "was the customer told" is the field a reviewer looks for.
 */
function serialise(request: {
  id: string;
  tenantId: string;
  requesterUserId: string;
  state: string;
  identityVerificationState: string;
  identityVerificationNote: string | null;
  identityVerifiedByUserId: string | null;
  identityVerifiedAt: Date | null;
  reason: string;
  externalReference: string | null;
  allowedModules: string[];
  allowedActions: string[];
  allowedResourceIds: string[];
  approverUserId: string | null;
  approvedAt: Date | null;
  approvalNote: string | null;
  deniedAt: Date | null;
  activatedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
  customerNotificationState: string;
  customerNotifiedAt: Date | null;
  notificationSuppressionReason: string | null;
  usageCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  version: number;
}): Record<string, unknown> {
  return {
    id: request.id,
    tenantId: request.tenantId,
    requesterUserId: request.requesterUserId,
    state: request.state,
    identityVerification: {
      state: request.identityVerificationState,
      note: request.identityVerificationNote,
      verifiedByUserId: request.identityVerifiedByUserId,
      verifiedAt: request.identityVerifiedAt,
    },
    reason: request.reason,
    externalReference: request.externalReference,
    allowedScope: {
      modules: request.allowedModules,
      actions: request.allowedActions,
      resourceIds: request.allowedResourceIds,
    },
    approval: {
      approverUserId: request.approverUserId,
      approvedAt: request.approvedAt,
      note: request.approvalNote,
      deniedAt: request.deniedAt,
    },
    window: {
      activatedAt: request.activatedAt,
      expiresAt: request.expiresAt,
      revokedAt: request.revokedAt,
      revokedByUserId: request.revokedByUserId,
      revocationReason: request.revocationReason,
    },
    customerNotification: {
      state: request.customerNotificationState,
      notifiedAt: request.customerNotifiedAt,
      suppressionReason: request.notificationSuppressionReason,
    },
    usage: { count: request.usageCount, lastUsedAt: request.lastUsedAt },
    createdAt: request.createdAt,
    version: request.version,
  };
}
