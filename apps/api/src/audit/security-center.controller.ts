import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import {
  SECURITY_CENTER_VIEWS,
  SECURITY_METRICS,
  SECURITY_TIME_RANGES,
  viewHasCorrelationIds,
  type SecurityCenterView,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import {
  RevokeSessionDto,
  SecurityCenterViewDto,
  SecurityPostureDto,
} from './security-center.dto.js';
import { SecurityCenterService } from './security-center.service.js';

/**
 * The Security Center — Prompt 32.
 *
 * ## Why this is a separate controller from `AuditController`
 *
 * They read the same evidence and answer different questions. `AuditController` is the trail: a
 * flat, filterable, verifiable list, whose caller knows what they are looking for. The Security
 * Center is a *posture* — eleven figures and seven purpose-shaped views, each of which knows
 * which question it answers. Merging them would mean one controller whose routes fall into two
 * unrelated shapes, and a vocabulary endpoint that serves two different screens.
 *
 * They share the service layer where it matters: the same `AuditTrailRepository` queries, the
 * same authorization gate, and one export path that records a security event. Nothing here
 * re-implements a trail read.
 *
 * ## The permission model, in one place
 *
 * * Reading anything — `settings:Audit` at whole-company scope. `CompanyAdmin` and `Auditor`
 *   hold it; `Manager`, `Approver` and `Employee` do not.
 * * Exporting — additionally `settings:Export`, so investigating and taking the evidence away are
 *   separable grants.
 * * Revoking a session — `settings:Administer`, because it is an act rather than a read. An
 *   `Auditor`, who holds `Audit` and `Export` and no write action anywhere, cannot sign anyone
 *   out — which is the point of that role.
 */
@Controller('tenants/:tenantId/security-center')
@TenantScoped()
export class SecurityCenterController {
  constructor(
    private readonly securityCenter: SecurityCenterService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The vocabulary, so the screen builds its tabs, its filters and its cards from the server.
   *
   * Including which views carry a correlation id. The prompt asks for "correlation ID/resource
   * links", and a live session or a guest membership is *state* with no correlating request — a
   * UI that offered a correlation-id filter on those views would send an investigator looking for
   * a request that never existed.
   */
  @Get('vocabulary')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  vocabulary(): Record<string, unknown> {
    return {
      views: this.securityCenter.views().map((view) => ({
        ...view,
        hasCorrelationIds: viewHasCorrelationIds(view.view),
      })),
      metrics: SECURITY_METRICS,
      ranges: SECURITY_TIME_RANGES,
      note:
        'The Security Center composes the records each module already keeps. It stores nothing ' +
        'of its own, so what it shows is the same evidence the audit and security trails hold — ' +
        'which is why no administrator, here or anywhere, can edit or delete it.',
    };
  }

  /** The eleven metrics, over a window the caller chooses. */
  @Get('posture')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  async posture(@Query() query: SecurityPostureDto): Promise<unknown> {
    return this.securityCenter.posture({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.range === undefined ? {} : { range: query.range }),
      ...(query.guestHorizonDays === undefined ? {} : { guestHorizonDays: query.guestHorizonDays }),
    });
  }

  /** One view's rows. */
  @Get('views/:view')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  async view(@Param('view') view: string, @Query() query: SecurityCenterViewDto): Promise<unknown> {
    return this.securityCenter.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      view: SecurityCenterController.requireView(view),
      ...SecurityCenterController.filters(query),
      ...(query.before === undefined ? {} : { before: new Date(query.before) }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  /**
   * Export a view.
   *
   * A `POST` despite reading nothing, for the reason the audit export already gives: it writes a
   * security event recording who took a copy, so it is not safe, idempotent or cacheable and
   * should not look like it is.
   */
  @Post('views/:view/export')
  @RequirePermission({ module: 'settings', action: 'Export' })
  async exportView(
    @Param('view') view: string,
    @Query() query: SecurityCenterViewDto,
  ): Promise<unknown> {
    return this.securityCenter.exportView({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      view: SecurityCenterController.requireView(view),
      ...SecurityCenterController.filters(query),
    });
  }

  /**
   * Sign somebody out.
   *
   * `settings:Administer`, and a reason is mandatory. This closes the gap Prompt 5 recorded in as
   * many words — admin session revoke was platform-only "because company-admin session revoke
   * needs the role model, which arrives at Prompt 7".
   */
  @Post('sessions/:sessionId/revoke')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async revokeSession(
    @Param('sessionId') sessionId: string,
    @Query() query: RevokeSessionDto,
  ): Promise<unknown> {
    return this.securityCenter.revokeSession({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      sessionId,
      reason: query.reason,
    });
  }

  private static filters(query: SecurityCenterViewDto): {
    range?: SecurityCenterViewDto['range'];
    actorFilter?: string;
    correlationId?: string;
    severity?: SecurityCenterViewDto['severity'];
    outcome?: SecurityCenterViewDto['outcome'];
    guestHorizonDays?: number;
  } {
    return {
      ...(query.range === undefined ? {} : { range: query.range }),
      ...(query.actorUserId === undefined ? {} : { actorFilter: query.actorUserId }),
      ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
      ...(query.severity === undefined ? {} : { severity: query.severity }),
      ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      ...(query.guestHorizonDays === undefined ? {} : { guestHorizonDays: query.guestHorizonDays }),
    };
  }

  /**
   * The view name is a path parameter, so it is validated here rather than by a DTO.
   *
   * A 404 rather than a 400: `/views/whatever` is a route that does not exist, and answering 400
   * would imply the view might exist with better parameters.
   */
  private static requireView(view: string): SecurityCenterView {
    const found = SECURITY_CENTER_VIEWS.find((candidate) => candidate === view);
    if (found === undefined) {
      throw new NotFoundException(
        `There is no "${view}" view. The views are: ${SECURITY_CENTER_VIEWS.join(', ')}.`,
      );
    }
    return found;
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('The Security Center is for signed-in company members.');
    }
    return id;
  }
}
