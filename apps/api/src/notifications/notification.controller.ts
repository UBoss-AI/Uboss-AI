import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import {
  NOTIFICATION_DIGESTS,
  NOTIFICATION_KINDS,
  type NotificationDigest,
  type NotificationKind,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { NotificationService } from './notification.service.js';

/** `?unread=true` arrives as the string `"true"`. */
const asBoolean = () =>
  Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  );

export class CenterQueryDto {
  @IsOptional() @asBoolean() @IsBoolean() unread?: boolean;
  @IsOptional() @asBoolean() @IsBoolean() assignedToMe?: boolean;
  @IsOptional() @asBoolean() @IsBoolean() awaitingAcknowledgement?: boolean;

  @IsOptional() @IsIn(NOTIFICATION_KINDS) kind?: NotificationKind;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) take?: number;

  /** Keyset cursor: the `occurredAt` of the last row on the previous page. */
  @IsOptional() @IsISO8601() before?: string;
}

export class MarkReadDto {
  @IsArray()
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class SetPreferenceDto {
  @IsIn(NOTIFICATION_KINDS) kind!: NotificationKind;
  @IsBoolean() inAppEnabled!: boolean;
  @IsBoolean() emailEnabled!: boolean;
  @IsIn(NOTIFICATION_DIGESTS) digest!: NotificationDigest;
}

/**
 * The Notification Center, the bell, and one person's preferences.
 *
 * ## Every route here is about the caller's **own** notifications
 *
 * There is no route that reads somebody else's, and no permission that governs reading your own —
 * the row was addressed to this person. Both are deliberate. A "read anybody's notifications"
 * permission would be a surveillance feature nobody asked for, and requiring a permission to see
 * your own bell would mean a guest could not be told they had been invited.
 *
 * The route permission is `dashboard:View`, which every user type holds: it exists so an
 * unauthenticated or non-member request is refused by the guard rather than by a null check.
 * Recipient scoping is in the repository's `where` clause, not a check afterwards, so a valid id
 * belonging to somebody else simply matches nothing.
 */
@Controller('tenants/:tenantId/notifications')
@TenantScoped()
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The center, or the bell's drawer. Same data, filtered. */
  @Get()
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async center(@Query() query: CenterQueryDto): Promise<unknown> {
    return this.notifications.centerFor({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      filter: {
        ...(query.unread === undefined ? {} : { unreadOnly: query.unread }),
        ...(query.assignedToMe === undefined ? {} : { assignedToMeOnly: query.assignedToMe }),
        ...(query.awaitingAcknowledgement === undefined
          ? {}
          : { awaitingAcknowledgementOnly: query.awaitingAcknowledgement }),
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.take === undefined ? {} : { take: query.take }),
        ...(query.before === undefined ? {} : { before: new Date(query.before) }),
      },
    });
  }

  /**
   * Just the counts, for the bell.
   *
   * A separate route because the bell is on every screen and does not need fifty rows to draw a
   * badge. Three numbers, because "unread" and "needs acknowledging" are different states and the
   * second is not cleared by looking.
   */
  @Get('counts')
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async counts(): Promise<unknown> {
    const view = await this.notifications.centerFor({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      filter: { take: 1 },
    });
    return view.counts;
  }

  @Post('read')
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async markRead(@Body() body: MarkReadDto): Promise<unknown> {
    const marked = await this.notifications.markRead({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      ids: body.ids,
    });
    return { marked };
  }

  @Post('read-all')
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async markAllRead(): Promise<unknown> {
    const marked = await this.notifications.markAllRead({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
    });
    return {
      marked,
      note:
        'Anything that needs acknowledgement is still waiting for it. Reading a critical alert ' +
        'is not the same as saying you have seen it.',
    };
  }

  /** Acknowledge a critical item. Audited, because it is an assertion somebody made. */
  @Post(':id/acknowledge')
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async acknowledge(@Param('id') id: string): Promise<unknown> {
    const notification = await this.notifications.acknowledge({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      id,
    });
    return {
      id: notification.id,
      acknowledgedAt: notification.acknowledgedAt?.toISOString() ?? null,
    };
  }

  /** Every kind, with the caller's choice or the default, and whether it can be changed. */
  @Get('preferences')
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async preferences(): Promise<unknown> {
    return this.notifications.preferencesFor({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
    });
  }

  /** Change one. Refused for a mandatory kind, with the reason rather than a constraint name. */
  @Put('preferences')
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async setPreference(@Body() body: SetPreferenceDto): Promise<unknown> {
    return this.notifications.setPreference({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      kind: body.kind,
      inAppEnabled: body.inAppEnabled,
      emailEnabled: body.emailEnabled,
      digest: body.digest,
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
