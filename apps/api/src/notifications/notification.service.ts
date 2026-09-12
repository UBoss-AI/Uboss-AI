import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import {
  isMandatoryNotification,
  NOTIFICATION_KIND_DEFINITIONS,
  notificationKind,
  type NotificationDigest,
  type NotificationKind,
  type NotificationSeverity,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import type { Notification } from '../generated/prisma/client.js';
import {
  NotificationRepository,
  type CenterFilter,
} from '../persistence/notification.repository.js';
import { OUTBOX_TOPICS, OutboxRepository } from '../persistence/outbox.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

export interface RaiseNotificationInput {
  tenantId: string;
  recipientUserId: string;
  kind: NotificationKind;
  severity?: NotificationSeverity | undefined;
  title: string;
  body: string;
  /** Workspace-relative, e.g. `/approvals/abc`. The database refuses anything else. */
  deepLink: string;
  resourceType: string;
  resourceId?: string | undefined;
  /** True when this person is the one the work is assigned to. Drives "assigned to me". */
  isAssignedToRecipient?: boolean | undefined;
  /** See `notificationDedupeKey` — its shape decides what "duplicate" means. */
  dedupeKey: string;
  /** When it should escalate if unacknowledged. Omit for something that never escalates. */
  escalatesAt?: Date | undefined;
  escalatedFromId?: string | undefined;
  occurredAt?: Date | undefined;
}

export interface RaiseResult {
  notification: Notification | null;
  /** True when the dedupe key had already been used, so nothing new was created. */
  suppressedAsDuplicate: boolean;
  /** False when the recipient's preference turned the in-app notification off. */
  deliveredInApp: boolean;
  emailQueued: boolean;
  /** True when a preference was overridden because the alert is mandatory. */
  preferenceOverridden: boolean;
}

export interface NotificationCenterView {
  counts: { unread: number; awaitingAcknowledgement: number; assignedToMeUnread: number };
  items: {
    id: string;
    kind: NotificationKind;
    kindLabel: string;
    severity: NotificationSeverity;
    title: string;
    body: string;
    deepLink: string;
    resourceType: string;
    resourceId: string | null;
    isAssignedToRecipient: boolean;
    isMandatory: boolean;
    requiresAcknowledgement: boolean;
    read: boolean;
    acknowledged: boolean;
    escalated: boolean;
    escalatedFromId: string | null;
    occurredAt: string;
  }[];
  /** `occurredAt` to pass as `before` for the next page, or null at the end. */
  nextBefore: string | null;
}

/**
 * The notification and escalation engine.
 *
 * ## One row per recipient, and delivery decided per recipient
 *
 * `raise` notifies **one person**. A caller with six approvers calls it six times, and each call
 * consults that person's preference, their own dedupe key and their own escalation deadline.
 * Batching it into one "notify these people" call would have made the preference check a loop
 * inside the engine and the dedupe key ambiguous, and the first thing anybody would want is the
 * per-person result this returns.
 *
 * ## A mandatory alert ignores preferences, and the row says so
 *
 * `isMandatoryNotification` from `@uboss/types` is the single answer — the same function the
 * preference screen asks when deciding which controls to disable. A critical event, and anything
 * of kind `SecurityEvent`, is delivered in-app **and** by email whatever the preference says, and
 * `preferenceOverridden` is returned so a caller can tell that happened. The database enforces
 * the same rule from the other side: a `SecurityEvent` preference cannot be stored muted, and a
 * critical notification cannot be stored non-mandatory.
 *
 * ## Email goes through the Prompt 10 outbox
 *
 * Not a second queue. `OutboxRepository` already gives at-least-once delivery inside the caller's
 * transaction, an idempotency key, exponential backoff and dead-lettering, and it has carried a
 * documented "no dispatcher exists yet" limitation since Prompt 10. This is that dispatcher's
 * producer — so the queue and its consumer were built and tested separately, which is the only
 * way to know the queue works.
 *
 * ## Escalation is a new notification, not a state change
 *
 * When something goes unacknowledged past its deadline, the original is marked `escalatedAt` and
 * a **new** notification is raised for the recipient's reporting manager, carrying
 * `escalatedFromId`. Two rows rather than a reassignment, because the person who was originally
 * asked still needs to see it and the manager needs their own read and acknowledgement state.
 * Reassigning would erase the fact that the first person was asked at all.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationRepository,
    private readonly outbox: OutboxRepository,
    private readonly auditEvents: AuditEventService,
  ) {}

  /**
   * Raise one notification for one person.
   *
   * **Assumes the caller's transaction where there is one**, so a notification commits with the
   * work that caused it. An invitation that was sent with no "you have been invited" is a support
   * ticket; a "you have been invited" for an invitation that rolled back is worse.
   */
  async raise(input: RaiseNotificationInput): Promise<RaiseResult> {
    const definition = notificationKind(input.kind);
    if (!definition) {
      throw new BadRequestException(`Unknown notification kind: ${input.kind}`);
    }

    const severity: NotificationSeverity = input.severity ?? 'Info';
    const mandatory = isMandatoryNotification({ kind: input.kind, severity });

    return this.prisma.runInTenantTransaction(
      { tenantId: input.tenantId } as TenantScope,
      async () => {
        const preference = await this.notifications.preferenceWithinCurrentScope(
          input.tenantId,
          input.recipientUserId,
          input.kind,
        );

        // Absent means the documented default — on, both channels — so somebody who has never
        // opened the preference screen is fully configured. The same shape as company settings.
        const inAppWanted = preference?.inAppEnabled ?? true;
        const emailWanted = preference?.emailEnabled ?? true;
        const digest: NotificationDigest = preference?.digest ?? 'Off';

        const deliverInApp = mandatory || inAppWanted;
        const preferenceOverridden = mandatory && !(inAppWanted && emailWanted && digest === 'Off');

        if (!deliverInApp) {
          // Muted, and legitimately so. Nothing is stored: a notification row nobody will ever be
          // shown is a row that makes the unread count wrong.
          return {
            notification: null,
            suppressedAsDuplicate: false,
            deliveredInApp: false,
            emailQueued: false,
            preferenceOverridden: false,
          };
        }

        const created = await this.notifications.createWithinCurrentScope({
          tenantId: input.tenantId,
          recipientUserId: input.recipientUserId,
          kind: input.kind,
          severity,
          title: input.title.trim(),
          body: input.body.trim(),
          deepLink: input.deepLink,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          isAssignedToRecipient: input.isAssignedToRecipient ?? false,
          isMandatory: mandatory,
          // A critical item is not cleared by being looked at. The database insists on this pairing.
          requiresAcknowledgement: mandatory && severity === 'Critical',
          readAt: null,
          acknowledgedAt: null,
          dedupeKey: input.dedupeKey,
          escalatesAt: input.escalatesAt ?? null,
          escalatedAt: null,
          escalatedFromId: input.escalatedFromId ?? null,
          emailQueuedAt: null,
          occurredAt: input.occurredAt ?? new Date(),
        });

        if (created === null) {
          // The expected outcome of a retried handler, not an error.
          return {
            notification: null,
            suppressedAsDuplicate: true,
            deliveredInApp: false,
            emailQueued: false,
            preferenceOverridden: false,
          };
        }

        // A mandatory alert is emailed immediately whatever the digest says. A digest is a request
        // for less noise, and "your account was accessed from a new country, in Friday's summary"
        // is not a reasonable reading of it.
        const emailNow = mandatory || (emailWanted && digest === 'Off');
        let emailQueued = false;
        // The row as the caller will see it. `markEmailQueuedWithinCurrentScope` returns the
        // updated version, so `result.notification.emailQueuedAt` is the truth rather than the
        // pre-update value — a caller reading a stale field would conclude no email was queued.
        let current = created;

        if (emailNow) {
          await this.outbox.enqueue({
            topic: OUTBOX_TOPICS.notificationEmail,
            tenantId: input.tenantId,
            // The notification id, so a retried enqueue collides rather than sending twice. The
            // payload carries **no address and no content** — the dispatcher reads both through
            // the services that own them, the same rule as the activation payload.
            idempotencyKey: `notification-email:${created.id}`,
            payload: { notificationId: created.id, tenantId: input.tenantId },
          });
          current = await this.notifications.markEmailQueuedWithinCurrentScope(created.id);
          emailQueued = true;
        }

        await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
          action: 'notification.raised',
          resourceType: 'notification',
          resourceId: created.id,
          summary: `${definition.label}: ${created.title}`,
          metadata: {
            kind: input.kind,
            severity,
            recipientUserId: input.recipientUserId,
            isMandatory: mandatory,
            preferenceOverridden,
            emailQueued,
            // Stated in the trail: queued is not delivered.
            note: emailQueued ? 'Email enqueued for delivery, not yet delivered.' : 'In-app only.',
          },
        });

        return {
          notification: current,
          suppressedAsDuplicate: false,
          deliveredInApp: true,
          emailQueued,
          preferenceOverridden,
        };
      },
    );
  }

  /** The Notification Center, or the bell's drawer — the same data, filtered. */
  async centerFor(input: {
    scope: TenantScope;
    userId: string;
    filter: CenterFilter;
  }): Promise<NotificationCenterView> {
    // No permission check on reading your **own** notifications. There is no permission that
    // could sensibly govern it — the row was addressed to this person — and requiring one would
    // mean a guest with a resource-scoped grant could not see that they had been invited.
    const [counts, rows] = await Promise.all([
      this.notifications.counts(input.scope, input.userId),
      this.notifications.center(input.scope, input.userId, input.filter),
    ]);

    const take = Math.min(input.filter.take ?? 50, 200);

    return {
      counts,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        kindLabel: notificationKind(row.kind)?.label ?? row.kind,
        severity: row.severity,
        title: row.title,
        body: row.body,
        deepLink: row.deepLink,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        isAssignedToRecipient: row.isAssignedToRecipient,
        isMandatory: row.isMandatory,
        requiresAcknowledgement: row.requiresAcknowledgement,
        read: row.readAt !== null,
        acknowledged: row.acknowledgedAt !== null,
        escalated: row.escalatedAt !== null,
        escalatedFromId: row.escalatedFromId,
        occurredAt: row.occurredAt.toISOString(),
      })),
      nextBefore: rows.length < take ? null : (rows.at(-1)?.occurredAt.toISOString() ?? null),
    };
  }

  async markRead(input: { scope: TenantScope; userId: string; ids: string[] }): Promise<number> {
    return this.notifications.markRead(input.scope, input.userId, input.ids);
  }

  async markAllRead(input: { scope: TenantScope; userId: string }): Promise<number> {
    return this.notifications.markAllRead(input.scope, input.userId);
  }

  /**
   * Acknowledge a critical item.
   *
   * Audited, unlike marking read: an acknowledgement is somebody asserting they have seen a
   * critical alert, and that assertion is the thing an incident review asks about. Read state is
   * housekeeping.
   */
  async acknowledge(input: {
    scope: TenantScope;
    userId: string;
    id: string;
  }): Promise<Notification> {
    const before = await this.notifications.findForRecipient(input.scope, input.userId, input.id);
    if (!before) {
      // Not found rather than forbidden: revealing that somebody *else's* notification exists
      // would be a small leak, and there is nothing this person could do with the id anyway.
      throw new NotFoundException('There is no such notification addressed to you.');
    }

    const after = await this.notifications.acknowledge(input.scope, input.userId, input.id);
    if (!after) {
      throw new NotFoundException('There is no such notification addressed to you.');
    }

    if (before.acknowledgedAt === null) {
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'notification.acknowledged',
          resourceType: 'notification',
          resourceId: after.id,
          actorUserId: input.userId,
          summary: `Acknowledged: ${after.title}`,
          metadata: { kind: after.kind, severity: after.severity },
        }),
      );
    }

    return after;
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  /**
   * The preference screen's data: every kind, with the stored choice or the default, and
   * **whether it can be changed at all**.
   */
  async preferencesFor(input: { scope: TenantScope; userId: string }): Promise<{
    preferences: {
      kind: NotificationKind;
      label: string;
      description: string;
      inAppEnabled: boolean;
      emailEnabled: boolean;
      digest: NotificationDigest;
      /** False for a kind nobody may mute. The screen disables the controls; the server refuses. */
      mutable: boolean;
      /** Whether a value was stored, or is the documented default. */
      source: 'chosen' | 'default';
      producedBy: string;
    }[];
    note: string;
  }> {
    const stored = await this.notifications.preferences(input.scope, input.userId);
    const byKind = new Map(stored.map((row) => [row.kind, row]));

    return {
      preferences: NOTIFICATION_KIND_DEFINITIONS.map((definition) => {
        const row = byKind.get(definition.kind);
        return {
          kind: definition.kind,
          label: definition.label,
          description: definition.description,
          inAppEnabled: definition.alwaysMandatory ? true : (row?.inAppEnabled ?? true),
          emailEnabled: definition.alwaysMandatory ? true : (row?.emailEnabled ?? true),
          digest: definition.alwaysMandatory ? 'Off' : (row?.digest ?? 'Off'),
          mutable: !definition.alwaysMandatory,
          source: row ? ('chosen' as const) : ('default' as const),
          producedBy: definition.producedBy,
        };
      }),
      note:
        'Security alerts cannot be turned off, and neither can anything raised as Critical — a ' +
        'critical alert of any kind is delivered in-app and by email whatever these say. A kind ' +
        'with no stored choice uses the documented default, so nothing has to be configured for ' +
        'notifications to work.',
    };
  }

  /**
   * Change one preference.
   *
   * Refused for a mandatory kind, with the reason. The database refuses it too — this message
   * exists so somebody gets an explanation rather than a constraint name.
   */
  async setPreference(input: {
    scope: TenantScope;
    userId: string;
    kind: NotificationKind;
    inAppEnabled: boolean;
    emailEnabled: boolean;
    digest: NotificationDigest;
  }): Promise<{ kind: NotificationKind; note: string }> {
    const definition = notificationKind(input.kind);
    if (!definition) {
      throw new BadRequestException(`Unknown notification kind: ${input.kind}`);
    }

    if (definition.alwaysMandatory) {
      throw new BadRequestException(
        `${definition.label} cannot be changed. These alerts exist so that somebody finds out ` +
          'about a security event whether or not they wanted to be told, and a preference that ' +
          'could suppress one would defeat the purpose of having them.',
      );
    }

    await this.notifications.upsertPreference(input.scope, {
      userId: input.userId,
      kind: input.kind,
      inAppEnabled: input.inAppEnabled,
      emailEnabled: input.emailEnabled,
      digest: input.digest,
    });

    return {
      kind: input.kind,
      note:
        input.inAppEnabled || input.emailEnabled
          ? 'Saved.'
          : 'Saved — this kind is now off on both channels. Anything raised as Critical will ' +
            'still reach you, because a critical alert cannot be muted.',
    };
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  /**
   * Escalate everything past its deadline that nobody has acknowledged.
   *
   * Platform-plane, one pass for the whole platform. Returns what it did rather than logging it,
   * so the endpoint that runs it can report and a test can assert.
   *
   * `resolveEscalationTarget` is injected rather than imported so this service does not depend on
   * the organization module — the reporting hierarchy is Prompt 12's, and a notification engine
   * that imported the org chart would be a circular dependency the moment offboarding wanted to
   * notify somebody.
   */
  async escalateDue(
    resolveEscalationTarget: (input: {
      tenantId: string;
      recipientUserId: string;
    }) => Promise<string | null>,
    limit = 100,
  ): Promise<{ escalated: number; noManager: number; alreadyEscalated: number }> {
    const due = await this.notifications.dueForEscalation(limit);

    let escalated = 0;
    let noManager = 0;

    for (const original of due) {
      const managerUserId = await resolveEscalationTarget({
        tenantId: original.tenantId,
        recipientUserId: original.recipientUserId,
      });

      if (managerUserId === null || managerUserId === original.recipientUserId) {
        // Nobody to escalate to. The original is **left un-escalated on purpose** so that giving
        // somebody a manager later escalates it then, rather than the sweeper having quietly
        // marked it done. A company with a flat top of the hierarchy would otherwise lose the
        // escalation permanently.
        noManager += 1;
        continue;
      }

      const definition = notificationKind(original.kind);

      const result = await this.prisma.runInTenantTransaction(
        { tenantId: original.tenantId } as TenantScope,
        async () => {
          const raised = await this.raise({
            tenantId: original.tenantId,
            recipientUserId: managerUserId,
            kind: original.kind,
            // One step up in severity, floored at Warning: an escalation that arrived looking
            // like information would be ignored exactly as the original was.
            severity: original.severity === 'Critical' ? 'Critical' : 'Warning',
            title: `Escalated: ${original.title}`,
            body:
              `${original.body}\n\nThis was raised for somebody who reports to you and has not ` +
              `been acknowledged since ${original.occurredAt.toISOString()}.`,
            deepLink: original.deepLink,
            resourceType: original.resourceType,
            ...(original.resourceId === null ? {} : { resourceId: original.resourceId }),
            // Not assigned to the manager: they are being told, not given the work. The
            // distinction is the whole point of the "assigned to me" filter.
            isAssignedToRecipient: false,
            dedupeKey: `escalation:${original.id}:${managerUserId}`,
            escalatedFromId: original.id,
          });

          // The original is marked escalated whether or not the manager's notification was
          // suppressed as a duplicate — a duplicate means it was already escalated to them, so
          // leaving the original un-marked would retry for ever.
          await this.notifications.markEscalatedWithinCurrentScope(original.id);

          await this.auditEvents.appendWithinCurrentScope(original.tenantId, {
            action: 'notification.escalated',
            resourceType: 'notification',
            resourceId: original.id,
            summary:
              `${definition?.label ?? original.kind} went unacknowledged and was escalated to ` +
              "the recipient's reporting manager.",
            metadata: {
              fromUserId: original.recipientUserId,
              toUserId: managerUserId,
              kind: original.kind,
              escalatedNotificationId: raised.notification?.id ?? null,
            },
          });

          return raised;
        },
      );

      if (result.notification !== null || result.suppressedAsDuplicate) {
        escalated += 1;
      }
    }

    return { escalated, noManager, alreadyEscalated: 0 };
  }
}
