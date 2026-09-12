import { Controller, Post, Query, UnauthorizedException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { notificationDedupeKey } from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { BudgetAlertService } from '../commercial/budget-alert.service.js';
import { ConnectionService } from '../connections/connection.service.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';
import { NotificationService } from './notification.service.js';

export class RunQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

/**
 * The two jobs behind notifications, exposed so they can be run.
 *
 * ## Why an endpoint rather than a timer
 *
 * There is no scheduler in this deployment and adding one is an operations decision (Prompts
 * 38–42). Prompt 11 set the precedent with `POST /companies/apply-due`, and the reasoning holds
 * here: a queue with no consumer is a queue that silently accumulates, and a callable endpoint is
 * both operable now and the natural thing for a cron to call later.
 *
 * The cost is stated plainly rather than hidden — **until something calls these on a timer, a
 * queued email waits and an unacknowledged alert does not escalate.** That is a real limitation
 * and it is in the documentation, not just here.
 *
 * ## Platform-plane, deliberately
 *
 * Both jobs cross companies: one dispatcher and one escalation sweep serve the whole platform.
 * `platform-dashboard:Administer` rather than a company permission, because a company
 * administrator running the platform's mail queue would be a strange thing to permit.
 */
@Controller('platform/notifications')
@PlatformOnly()
export class NotificationOperationsController {
  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    private readonly notifications: NotificationService,
    private readonly organization: OrganizationRepository,
    private readonly budgets: BudgetAlertService,
    private readonly connections: ConnectionService,
  ) {}

  /**
   * Deliver what is queued.
   *
   * The response carries the adapter's own description, so a caller can never read `delivered`
   * as "the customer received it" — with the default logging adapter it means "handed to
   * something that recorded it and sent nothing".
   */
  @Post('dispatch')
  @RequirePermission({ module: 'platform-dashboard', action: 'Administer' })
  async dispatch(@Query() query: RunQueryDto): Promise<unknown> {
    this.requirePlatformActor();
    const outcome = await this.dispatcher.runOnce(query.limit ?? 20);
    return {
      ...outcome,
      note: outcome.adapter.deliversRealMail
        ? 'Delivered through a real provider.'
        : 'Nothing was actually sent: ' + outcome.adapter.note,
    };
  }

  /**
   * Escalate everything unacknowledged past its deadline.
   *
   * The reporting hierarchy is Prompt 12's, and it is passed in as a function rather than
   * imported by the notification service — a notification engine that depended on the org chart
   * would be a circular dependency the moment offboarding wanted to notify somebody.
   */
  @Post('escalate-due')
  @RequirePermission({ module: 'platform-dashboard', action: 'Administer' })
  async escalateDue(@Query() query: RunQueryDto): Promise<unknown> {
    this.requirePlatformActor();

    const outcome = await this.notifications.escalateDue(async ({ tenantId, recipientUserId }) => {
      const employment = await this.organization.findEmploymentForPlatform(
        tenantId,
        recipientUserId,
      );
      return employment?.reportingManagerUserId ?? null;
    }, query.limit ?? 100);

    return {
      ...outcome,
      note:
        'Anything with no reporting manager is left un-escalated on purpose, so giving that ' +
        'person a manager later escalates it then. Marking it done would lose the escalation ' +
        'permanently for anybody at the top of a hierarchy.',
    };
  }

  /**
   * Raise budget and seat threshold alerts for every company that has newly crossed one.
   *
   * Idempotent by the dedupe key, so calling it repeatedly does nothing after the first time a
   * threshold is crossed — which is what makes it safe to put on a frequent timer.
   */
  @Post('budget-alerts')
  @RequirePermission({ module: 'platform-dashboard', action: 'Administer' })
  async budgetAlerts(): Promise<unknown> {
    this.requirePlatformActor();
    const outcome = await this.budgets.raiseDueAlerts();
    return {
      ...outcome,
      note:
        'A company with no active Company Admin is counted rather than skipped silently: an ' +
        'alert with nobody to receive it is itself worth knowing about.',
    };
  }

  /**
   * Notify connection owners whose credentials have expired or are about to.
   *
   * **This is the producer behind Prompt 15's `ConnectionExpiry` kind**, which shipped with its
   * preference controls working and nothing raising it. The sweep lives in the connection
   * service; the notification wording lives here, because the notification engine must not
   * depend on the connections module and the connections module must not depend on the
   * notification engine — the seam is a function passed in.
   *
   * Idempotent through the dedupe key, which is per connection **per state**: "expiring" and
   * "expired" are two different pieces of news, and a key without the state would tell somebody
   * their credential is expiring and then never tell them it had.
   */
  @Post('connection-expiry')
  @RequirePermission({ module: 'platform-dashboard', action: 'Administer' })
  async connectionExpiry(): Promise<unknown> {
    this.requirePlatformActor();

    const outcome = await this.connections.sweepExpiringCredentials(async (event) => {
      await this.notifications.raise({
        tenantId: event.tenantId,
        recipientUserId: event.recipientUserId,
        kind: 'ConnectionExpiry',
        // Expired is a live outage — every Engine Agent using it has stopped. Expiring is a
        // chance to avoid one.
        severity: event.state === 'Expired' ? 'Critical' : 'Warning',
        title:
          event.state === 'Expired'
            ? `The credential for "${event.label}" has expired`
            : `The credential for "${event.label}" expires soon`,
        body:
          event.state === 'Expired'
            ? `It expired ${event.expiresAt.toISOString()}. Every Engine Agent using this ` +
              'connection has stopped working. Rotate the credential to restore it.'
            : `It expires ${event.expiresAt.toISOString()}. Rotating it before then avoids an ` +
              'outage rather than reporting one.',
        deepLink: `/settings/connections/${event.connectionId}`,
        resourceType: 'connection',
        resourceId: event.connectionId,
        // Assigned to them: they own the connection, so rotating it is theirs to do.
        isAssignedToRecipient: true,
        dedupeKey: notificationDedupeKey.connectionExpiry(event.connectionId, event.state),
      });
    });

    return {
      ...outcome,
      note:
        'Keyed per connection per state, so "expiring" and "expired" are two notifications and ' +
        'neither repeats. Safe on a frequent timer.',
    };
  }

  private requirePlatformActor(): void {
    if (!actorUserId(getActor())) {
      throw new UnauthorizedException('This requires an identified platform actor.');
    }
  }
}
