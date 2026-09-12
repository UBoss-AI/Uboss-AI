import { Injectable } from '@nestjs/common';

import type { NotificationKind } from '@uboss/types';

import type { Notification, NotificationPreference } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

export interface CenterFilter {
  /** Only what has not been read. */
  unreadOnly?: boolean | undefined;
  /** Only what is assigned to this person, rather than what they are being kept informed of. */
  assignedToMeOnly?: boolean | undefined;
  kind?: NotificationKind | undefined;
  /** Only what still needs an acknowledgement. The queue a critical alert sits in. */
  awaitingAcknowledgementOnly?: boolean | undefined;
  take?: number | undefined;
  /** `occurredAt` of the last row on the previous page. Keyset, not offset. */
  before?: Date | undefined;
}

/**
 * Reads and writes for the Notification Center.
 *
 * Self-scoping like every repository since Prompt 6 (ADR-037), with one deliberate exception:
 * `createWithinCurrentScope` joins the caller's transaction. A notification must commit **with**
 * the thing that caused it — an invitation that was sent and a "you have been invited" that was
 * not is a support ticket, and the reverse is worse. The same reasoning as `OutboxRepository`,
 * and the name says so at every call site.
 */
@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert a notification inside the caller's transaction.
   *
   * Returns `null` when the dedupe key already exists for this person, rather than throwing: a
   * duplicate is the *expected* outcome of a retried handler, not an error, and a caller that had
   * to catch a unique-violation to find that out would eventually catch the wrong one.
   */
  async createWithinCurrentScope(
    data: Omit<Notification, 'id' | 'createdAt'> & { id?: string },
  ): Promise<Notification | null> {
    const existing = await this.prisma.client.notification.findFirst({
      where: {
        tenantId: data.tenantId,
        recipientUserId: data.recipientUserId,
        dedupeKey: data.dedupeKey,
      },
    });
    if (existing) {
      return null;
    }

    return this.prisma.client.notification.create({ data });
  }

  /** One page of the center, newest first. Keyset paged, so a new arrival cannot shift a page. */
  async center(
    scope: TenantScope,
    recipientUserId: string,
    filter: CenterFilter,
  ): Promise<Notification[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.notification.findMany({
        where: {
          tenantId: scope.tenantId,
          recipientUserId,
          ...(filter.unreadOnly ? { readAt: null } : {}),
          ...(filter.assignedToMeOnly ? { isAssignedToRecipient: true } : {}),
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
          ...(filter.awaitingAcknowledgementOnly
            ? { requiresAcknowledgement: true, acknowledgedAt: null }
            : {}),
          ...(filter.before === undefined ? {} : { occurredAt: { lt: filter.before } }),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: Math.min(filter.take ?? 50, 200),
      }),
    );
  }

  /**
   * The bell's numbers, in one round trip.
   *
   * Three counts rather than one, because the bell has to distinguish "you have unread items"
   * from "something needs acknowledging" — the second is not cleared by looking at it.
   */
  async counts(
    scope: TenantScope,
    recipientUserId: string,
  ): Promise<{ unread: number; awaitingAcknowledgement: number; assignedToMeUnread: number }> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const where = { tenantId: scope.tenantId, recipientUserId };
      const [unread, awaitingAcknowledgement, assignedToMeUnread] = await Promise.all([
        this.prisma.client.notification.count({ where: { ...where, readAt: null } }),
        this.prisma.client.notification.count({
          where: { ...where, requiresAcknowledgement: true, acknowledgedAt: null },
        }),
        this.prisma.client.notification.count({
          where: { ...where, readAt: null, isAssignedToRecipient: true },
        }),
      ]);
      return { unread, awaitingAcknowledgement, assignedToMeUnread };
    });
  }

  async findForRecipient(
    scope: TenantScope,
    recipientUserId: string,
    id: string,
  ): Promise<Notification | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.notification.findFirst({
        where: { tenantId: scope.tenantId, id, recipientUserId },
      }),
    );
  }

  /**
   * Mark read. Scoped to the recipient in the `where`, not checked afterwards, so one person
   * cannot clear another's bell even with a valid notification id.
   */
  async markRead(scope: TenantScope, recipientUserId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.notification.updateMany({
        where: {
          tenantId: scope.tenantId,
          recipientUserId,
          id: { in: ids },
          readAt: null,
        },
        data: { readAt: new Date() },
      });
      return result.count;
    });
  }

  async markAllRead(scope: TenantScope, recipientUserId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.notification.updateMany({
        where: { tenantId: scope.tenantId, recipientUserId, readAt: null },
        data: { readAt: new Date() },
      });
      return result.count;
    });
  }

  /**
   * Acknowledge one item.
   *
   * Sets `readAt` in the same statement when it is still null: the database requires
   * acknowledgement to imply having read, and a person who acknowledges straight from the list
   * has read it — insisting on two calls would be ceremony, and leaving `readAt` null would fail
   * the constraint.
   */
  async acknowledge(
    scope: TenantScope,
    recipientUserId: string,
    id: string,
  ): Promise<Notification | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.notification.findFirst({
        where: { tenantId: scope.tenantId, id, recipientUserId },
      });
      if (!existing || existing.acknowledgedAt !== null) {
        return existing;
      }

      const at = new Date();
      return this.prisma.client.notification.update({
        where: { id },
        data: { acknowledgedAt: at, readAt: existing.readAt ?? at },
      });
    });
  }

  /**
   * Notifications past their escalation deadline and not yet escalated.
   *
   * A **platform-plane** read across companies: the sweeper is one job for the whole platform,
   * and running it per tenant would mean the caller already knowing which tenants have overdue
   * work — which is what this query answers.
   */
  async dueForEscalation(limit = 100): Promise<Notification[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.notification.findMany({
        where: {
          escalatesAt: { not: null, lte: new Date() },
          escalatedAt: null,
          acknowledgedAt: null,
        },
        orderBy: { escalatesAt: 'asc' },
        take: Math.min(limit, 500),
      }),
    );
  }

  /** Mark the original as escalated. Joins the caller's transaction with the new notification. */
  async markEscalatedWithinCurrentScope(id: string): Promise<void> {
    await this.prisma.client.notification.update({
      where: { id },
      data: { escalatedAt: new Date() },
    });
  }

  /** Returns the updated row, so a caller does not hand back a stale one. */
  async markEmailQueuedWithinCurrentScope(id: string): Promise<Notification> {
    return this.prisma.client.notification.update({
      where: { id },
      data: { emailQueuedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  async preferences(scope: TenantScope, userId: string): Promise<NotificationPreference[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.notificationPreference.findMany({
        where: { tenantId: scope.tenantId, userId },
      }),
    );
  }

  /** One person's preference for one kind, read inside whatever scope the caller holds. */
  async preferenceWithinCurrentScope(
    tenantId: string,
    userId: string,
    kind: NotificationKind,
  ): Promise<NotificationPreference | null> {
    return this.prisma.client.notificationPreference.findFirst({
      where: { tenantId, userId, kind },
    });
  }

  async upsertPreference(
    scope: TenantScope,
    input: {
      userId: string;
      kind: NotificationKind;
      inAppEnabled: boolean;
      emailEnabled: boolean;
      digest: NotificationPreference['digest'];
    },
  ): Promise<NotificationPreference> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.notificationPreference.upsert({
        where: {
          tenantId_userId_kind: {
            tenantId: scope.tenantId,
            userId: input.userId,
            kind: input.kind,
          },
        },
        create: { tenantId: scope.tenantId, ...input },
        update: {
          inAppEnabled: input.inAppEnabled,
          emailEnabled: input.emailEnabled,
          digest: input.digest,
        },
      }),
    );
  }
}
