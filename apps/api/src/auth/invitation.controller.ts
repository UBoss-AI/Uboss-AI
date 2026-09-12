import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { isPlatformActor } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { CreateInvitationDto } from './auth.dto.js';
import { InvitationService } from './invitation.service.js';

/**
 * Invitation management.
 *
 * `@PlatformOnly` throughout, deliberately. Issuing an invitation grants someone access to a
 * company, so it needs a role check — and roles arrive at Prompt 7. The alternatives were both
 * worse: making these `@TenantScoped` would let *any* member invite colleagues, and inventing a
 * provisional role check now would be replaced wholesale at Prompt 7.
 *
 * The company-facing UI for this is Settings → Users & Access (Prompt 14), which is where the
 * approved design puts primary invitations.
 *
 * An invitation cannot create a company or a membership — it only enables an identity that a
 * company has already added. There is no public company signup.
 */
@Controller('invitations')
@PlatformOnly()
export class InvitationController {
  private readonly logger = new Logger(InvitationController.name);

  constructor(private readonly invitations: InvitationService) {}

  /**
   * Issue or resend an invitation.
   *
   * The activation token is returned **once**, in this response, because only its hash is
   * stored and it can never be retrieved again. Delivery by email belongs to the notifications
   * module (Prompt 28); until then the caller is responsible for handing it to the recipient.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async invite(@Body() body: CreateInvitationDto) {
    const actor = getActor();
    const invitedByUserId = isPlatformActor(actor) ? actor.userId : undefined;

    const issued = await this.invitations.invite({
      tenantId: body.tenantId,
      email: body.email,
      displayName: body.displayName,
      ...(invitedByUserId === undefined ? {} : { invitedByUserId }),
    });

    // Not logged: an activation token in a log file is a working credential.
    this.logger.log(
      `${issued.resent ? 'Resent' : 'Issued'} invitation ${issued.invitationId} for tenant ${body.tenantId}`,
    );

    return {
      invitationId: issued.invitationId,
      /** Shown once. Only a hash is stored; a lost token is resent, never recovered. */
      activationToken: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      resent: issued.resent,
    };
  }

  @Get()
  async list(@Query('tenantId') tenantId: string) {
    const invitations = await this.invitations.listForTenant(tenantId);

    return {
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        userId: invitation.userId,
        expiresAt: invitation.expiresAt.toISOString(),
        acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
        cancelledAt: invitation.cancelledAt?.toISOString() ?? null,
        resendCount: invitation.resendCount,
        createdAt: invitation.createdAt.toISOString(),
        // The token hash is never exposed, so this response cannot be used to forge a link.
      })),
    };
  }

  @Delete(':invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@Param('invitationId') invitationId: string, @Query('tenantId') tenantId: string) {
    const actor = getActor();
    await this.invitations.cancel(
      tenantId,
      invitationId,
      isPlatformActor(actor) ? actor.userId : undefined,
    );
  }
}
