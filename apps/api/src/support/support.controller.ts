import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  CUSTOMER_STATUS_STANCE,
  HEALTH_COMPONENT_LABELS,
  HEALTH_COMPONENTS,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_STATE_LABELS,
  INCIDENT_STATES,
  SUPPORT_ACCESS_STANCE,
  SUPPORT_AUTHORIZATION_MODE_DESCRIPTIONS,
  SUPPORT_AUTHORIZATION_MODE_LABELS,
  SUPPORT_AUTHORIZATION_MODES,
  SUPPORT_PRIORITIES,
  SUPPORT_TICKET_KIND_LABELS,
  SUPPORT_TICKET_KINDS,
  SUPPORT_TICKET_STATE_LABELS,
  SUPPORT_TICKET_STATES,
  type IncidentSeverity,
  type SupportPriority,
  type SupportTicketKind,
  type SupportTicketState,
} from '@uboss/types';

import { BreakGlassService } from '../audit/break-glass.service.js';
import { RequirePermission } from '../authorization/authorization.decorators.js';
import { PlatformAdministrationService } from '../platform/platform-administration.service.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { PlatformOnly, TenantScoped } from '../tenancy/tenancy.decorators.js';
import { SupportTicketService } from './support-ticket.service.js';
import { SystemHealthService } from './system-health.service.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

class RaiseTicketDto {
  @IsString() @MinLength(4) @MaxLength(300) subject!: string;
  @IsString() @MinLength(10) @MaxLength(8000) body!: string;

  @IsIn(SUPPORT_TICKET_KINDS as readonly string[], {
    message: `kind must be one of: ${SUPPORT_TICKET_KINDS.join(', ')}.`,
  })
  kind!: SupportTicketKind;

  @IsOptional()
  @IsIn(SUPPORT_PRIORITIES as readonly string[])
  priority?: SupportPriority;
}

class ReplyDto {
  @IsString() @MinLength(2) @MaxLength(8000) body!: string;
}

class OperatorNoteDto {
  @IsString() @MinLength(2) @MaxLength(8000) body!: string;
  /** Defaults to internal in the service. Sharing with the company is a deliberate act. */
  @IsOptional() @IsBoolean() isInternal?: boolean;
}

class AssignDto {
  @IsUUID(7) operatorUserId!: string;
}

class TransitionDto {
  @IsIn(SUPPORT_TICKET_STATES as readonly string[], {
    message: `to must be one of: ${SUPPORT_TICKET_STATES.join(', ')}.`,
  })
  to!: SupportTicketState;

  @IsOptional() @IsString() @MaxLength(4000) resolutionNote?: string;
}

class LinkIncidentDto {
  @IsOptional() @IsUUID(7) serviceAlertId?: string;
}

class DeclareIncidentDto {
  @IsIn(INCIDENT_SEVERITIES as readonly string[], {
    message: `severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}.`,
  })
  severity!: IncidentSeverity;

  @IsUUID(7) ownerUserId!: string;
}

class MitigateDto {
  @IsString() @MinLength(4) @MaxLength(4000) mitigation!: string;
}

class PublishDto {
  @IsBoolean() customerVisible!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) customerImpact?: string;
}

class AuthorizeSessionDto {
  @IsBoolean() authorized!: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

// ---------------------------------------------------------------------------
// The company's side
// ---------------------------------------------------------------------------

/**
 * Support, as a company sees it — Prompt 36.
 *
 * ## Why raising a ticket is `settings:View`
 *
 * The lowest company grant there is. Asking UBoss for help is not an administrative act, and a
 * product where only an administrator can report a problem is a product where problems go
 * unreported. What `View` does **not** get you is anybody else's ticket: every read here is
 * tenant-scoped and RLS-backed.
 *
 * ## Authorizing a support session is `settings:Administer`
 *
 * Letting UBoss into the company's data is the most consequential thing on this controller, so it
 * needs the grant that governs the company's configuration — and the route exists at all only
 * because the company's policy says it must. Under `NotRequired` there is nothing to decide.
 */
@Controller('tenants/:tenantId/support')
@TenantScoped()
export class SupportController {
  constructor(
    private readonly tickets: SupportTicketService,
    private readonly breakGlass: BreakGlassService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The vocabulary a screen renders from, plus what UBoss will and will not do. */
  @Get('meta')
  @RequirePermission({ module: 'settings', action: 'View' })
  async meta(): Promise<unknown> {
    return {
      kinds: SUPPORT_TICKET_KINDS.map((kind) => ({
        key: kind,
        label: SUPPORT_TICKET_KIND_LABELS[kind],
      })),
      priorities: SUPPORT_PRIORITIES,
      states: SUPPORT_TICKET_STATES.map((state) => ({
        key: state,
        label: SUPPORT_TICKET_STATE_LABELS[state],
      })),
      authorizationModes: SUPPORT_AUTHORIZATION_MODES.map((mode) => ({
        key: mode,
        label: SUPPORT_AUTHORIZATION_MODE_LABELS[mode],
        description: SUPPORT_AUTHORIZATION_MODE_DESCRIPTIONS[mode],
      })),
      // Served verbatim so the screen states what UBoss support can and cannot do in the
      // product's own words, rather than in wording a front-end author invented.
      accessStance: SUPPORT_ACCESS_STANCE,
    };
  }

  @Get('tickets')
  @RequirePermission({ module: 'settings', action: 'View' })
  async list(@Query('includeClosed') includeClosed?: string): Promise<unknown> {
    return {
      tickets: await this.tickets.listForCompany({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        includeClosed: includeClosed === 'true',
      }),
    };
  }

  @Post('tickets')
  @RequirePermission({ module: 'settings', action: 'View' })
  async raise(@Body() body: RaiseTicketDto): Promise<unknown> {
    return this.tickets.raise({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subject: body.subject,
      body: body.body,
      kind: body.kind,
      ...(body.priority === undefined ? {} : { priority: body.priority }),
    });
  }

  /** One ticket and its history — **replies only**, never an operator's internal notes. */
  @Get('tickets/:ticketId')
  @RequirePermission({ module: 'settings', action: 'View' })
  async detail(@Param('ticketId') ticketId: string): Promise<unknown> {
    return this.tickets.companyDetail({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ticketId,
    });
  }

  @Post('tickets/:ticketId/reply')
  @RequirePermission({ module: 'settings', action: 'View' })
  async reply(@Param('ticketId') ticketId: string, @Body() body: ReplyDto): Promise<unknown> {
    return this.tickets.replyAsCompany({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ticketId,
      body: body.body,
    });
  }

  /**
   * Support sessions this company is being asked to authorize.
   *
   * `settings:Administer`: seeing that UBoss has asked to come in is part of administering the
   * company, and the list carries the operator's stated reason.
   */
  @Get('access-requests')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async accessRequests(): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const requests = await this.breakGlass.awaitingCustomerAuthorization(scope.tenantId);

    return {
      mode: await this.breakGlass.authorizationModeFor(scope.tenantId),
      requests: requests.map((request) => ({
        id: request.id,
        reason: request.reason,
        externalReference: request.externalReference,
        allowedModules: request.allowedModules,
        allowedActions: request.allowedActions,
        state: request.state,
        expiresAt: request.expiresAt?.toISOString() ?? null,
        requestedAt: request.createdAt.toISOString(),
        customerAuthorizationState: request.customerAuthorizationState,
      })),
    };
  }

  /**
   * Authorize or decline one.
   *
   * **There is no bypass on the other side of this.** If the company declines, or simply never
   * answers, the session cannot be activated — the service refuses it and so does a check
   * constraint.
   */
  @Post('access-requests/:requestId')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async decide(
    @Param('requestId') requestId: string,
    @Body() body: AuthorizeSessionDto,
  ): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const updated = await this.breakGlass.recordCustomerAuthorization({
      requestId,
      tenantId: scope.tenantId,
      decidedByUserId: this.currentUserId(),
      authorized: body.authorized,
      ...(body.note === undefined ? {} : { note: body.note }),
    });

    return {
      id: updated.id,
      customerAuthorizationState: updated.customerAuthorizationState,
      decidedAt: updated.customerAuthorizedAt?.toISOString() ?? null,
    };
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Support is for signed-in company members.');
    }
    return id;
  }
}

// ---------------------------------------------------------------------------
// The operator's side
// ---------------------------------------------------------------------------

/**
 * Support & Operations, and System Health — the Master Console side of Prompt 36.
 *
 * Every route is `@PlatformOnly` and gated on the `support` or `system-health` platform module.
 * `PlatformSupport` holds `support: Administer` and `system-health: View`, and **nothing on any
 * company module** — which is the mechanism behind the prompt's *"platform support staff must not
 * automatically gain unrestricted tenant content access"*. The only route into a company's data is
 * a break-glass session, which lives on its own controller and carries its own approvals.
 */
@Controller('platform/support')
@PlatformOnly()
export class PlatformSupportController {
  constructor(
    private readonly tickets: SupportTicketService,
    private readonly health: SystemHealthService,
    private readonly administration: PlatformAdministrationService,
  ) {}

  @Get('meta')
  @RequirePermission({ module: 'support', action: 'View' })
  async meta(): Promise<unknown> {
    return {
      ticketStates: SUPPORT_TICKET_STATES.map((state) => ({
        key: state,
        label: SUPPORT_TICKET_STATE_LABELS[state],
      })),
      ticketKinds: SUPPORT_TICKET_KINDS,
      priorities: SUPPORT_PRIORITIES,
      incidentSeverities: INCIDENT_SEVERITIES.map((severity) => ({
        key: severity,
        label: INCIDENT_SEVERITY_LABELS[severity],
      })),
      incidentStates: INCIDENT_STATES.map((state) => ({
        key: state,
        label: INCIDENT_STATE_LABELS[state],
      })),
      healthComponents: HEALTH_COMPONENTS.map((component) => ({
        key: component,
        label: HEALTH_COMPONENT_LABELS[component],
      })),
      customerStatusStance: CUSTOMER_STATUS_STANCE,
    };
  }

  @Get('queue')
  @RequirePermission({ module: 'support', action: 'View' })
  async queue(): Promise<unknown> {
    return this.tickets.queueSummary();
  }

  @Get('tickets')
  @RequirePermission({ module: 'support', action: 'View' })
  async tickets_(
    @Query('state') state?: SupportTicketState,
    @Query('onlyOpen') onlyOpen?: string,
  ): Promise<unknown> {
    return {
      tickets: await this.tickets.listForOperator({
        ...(state === undefined ? {} : { state }),
        onlyOpen: onlyOpen === 'true',
      }),
    };
  }

  /** One ticket, with **every** note — this is the operator's view. */
  @Get('tickets/:ticketId')
  @RequirePermission({ module: 'support', action: 'View' })
  async ticket(@Param('ticketId') ticketId: string): Promise<unknown> {
    return this.tickets.operatorDetail(ticketId);
  }

  @Post('tickets/:ticketId/assign')
  @RequirePermission({ module: 'support', action: 'EditDraft' })
  async assign(@Param('ticketId') ticketId: string, @Body() body: AssignDto): Promise<unknown> {
    return this.tickets.assign({
      ticketId,
      operatorUserId: body.operatorUserId,
      actorUserId: this.currentUserId(),
    });
  }

  @Post('tickets/:ticketId/state')
  @RequirePermission({ module: 'support', action: 'EditDraft' })
  async transition(
    @Param('ticketId') ticketId: string,
    @Body() body: TransitionDto,
  ): Promise<unknown> {
    return this.tickets.transition({
      ticketId,
      actorUserId: this.currentUserId(),
      to: body.to,
      ...(body.resolutionNote === undefined ? {} : { resolutionNote: body.resolutionNote }),
    });
  }

  @Post('tickets/:ticketId/notes')
  @RequirePermission({ module: 'support', action: 'Comment' })
  async note(@Param('ticketId') ticketId: string, @Body() body: OperatorNoteDto): Promise<unknown> {
    return this.tickets.addOperatorNote({
      ticketId,
      actorUserId: this.currentUserId(),
      body: body.body,
      ...(body.isInternal === undefined ? {} : { isInternal: body.isInternal }),
    });
  }

  @Post('tickets/:ticketId/incident')
  @RequirePermission({ module: 'support', action: 'EditDraft' })
  async link(@Param('ticketId') ticketId: string, @Body() body: LinkIncidentDto): Promise<unknown> {
    return this.tickets.linkToIncident({
      ticketId,
      serviceAlertId: body.serviceAlertId ?? null,
      actorUserId: this.currentUserId(),
    });
  }

  // ---- Incidents ----

  @Post('incidents/:alertId/declare')
  @RequirePermission({ module: 'support', action: 'Administer' })
  async declare(
    @Param('alertId') alertId: string,
    @Body() body: DeclareIncidentDto,
  ): Promise<unknown> {
    return this.administration.declareIncident({
      actorUserId: this.currentUserId(),
      alertId,
      severity: body.severity,
      ownerUserId: body.ownerUserId,
    });
  }

  @Post('incidents/:alertId/mitigate')
  @RequirePermission({ module: 'support', action: 'Administer' })
  async mitigate(@Param('alertId') alertId: string, @Body() body: MitigateDto): Promise<unknown> {
    return this.administration.mitigateIncident({
      actorUserId: this.currentUserId(),
      alertId,
      mitigation: body.mitigation,
    });
  }

  /** Publish to customers, or withdraw. `Administer`: it speaks to every company at once. */
  @Post('incidents/:alertId/publish')
  @RequirePermission({ module: 'support', action: 'Administer' })
  async publish(@Param('alertId') alertId: string, @Body() body: PublishDto): Promise<unknown> {
    return this.administration.publishIncident({
      actorUserId: this.currentUserId(),
      alertId,
      customerVisible: body.customerVisible,
      ...(body.customerImpact === undefined ? {} : { customerImpact: body.customerImpact }),
    });
  }

  @Get('incidents/:alertId/tickets')
  @RequirePermission({ module: 'support', action: 'View' })
  async incidentTickets(@Param('alertId') alertId: string): Promise<unknown> {
    return this.tickets.ticketsForIncident(alertId);
  }

  // ---- System Health ----

  @Get('health')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async systemHealth(): Promise<unknown> {
    return this.health.operatorView();
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Support operations are for signed-in platform staff.');
    }
    return id;
  }
}

// ---------------------------------------------------------------------------
// What a company may see about UBoss's own health
// ---------------------------------------------------------------------------

/**
 * The customer-visible status — Prompt 36's *"permitted customer-visible status where
 * appropriate"*.
 *
 * Tenant-scoped and gated on `settings:View`, so it is a signed-in company member reading it
 * rather than the public internet: UBoss's incident history is not a public status page and the
 * approved documents do not ask for one.
 *
 * **It returns published incidents and nothing else** — no component list, no latency, no error
 * text, no service name. A company learns that UBoss is degraded and what an operator chose to say
 * about it, and an outage nobody published reads as `ok`. That is a deliberate trade: UBoss says
 * nothing rather than leaking an internal reading it did not mean to publish.
 */
@Controller('tenants/:tenantId/service-status')
@TenantScoped()
export class ServiceStatusController {
  constructor(private readonly health: SystemHealthService) {}

  @Get()
  @RequirePermission({ module: 'settings', action: 'View' })
  async status(): Promise<unknown> {
    return {
      ...(await this.health.customerVisibleStatus()),
      stance: CUSTOMER_STATUS_STANCE,
    };
  }
}
