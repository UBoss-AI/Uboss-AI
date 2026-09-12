import { Injectable, Logger } from '@nestjs/common';

import { notificationKind } from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import type { OutboxMessage } from '../generated/prisma/client.js';
import { OUTBOX_TOPICS, OutboxRepository } from '../persistence/outbox.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { UserRepository } from '../persistence/user.repository.js';
import { EmailAdapter, maskEmail } from './email-adapter.js';

export interface DispatchOutcome {
  claimed: number;
  delivered: number;
  failed: number;
  /** Rows for a topic this dispatcher does not handle. Left for whatever owns them. */
  skipped: number;
  /** What the adapter is, so a caller never reads a delivered count as "the mail arrived". */
  adapter: { name: string; deliversRealMail: boolean; note: string };
}

/**
 * The outbox dispatcher.
 *
 * ## This closes the Prompt 10 limitation
 *
 * `OutboxRepository` has carried a documented "no dispatcher exists yet" note since Prompt 10:
 * rows accumulated as `Pending`, the claim/deliver/fail methods existed and were tested, and
 * nothing consumed them. That was deliberate — a queue and its consumer written together and
 * never exercised apart are two halves of one untested thing. This is the consumer.
 *
 * ## What it does not do
 *
 * **It does not run itself.** There is no scheduler in this deployment, and adding one is an
 * operations decision (Prompts 38–42), so `runOnce` is called by an endpoint — exactly the
 * precedent Prompt 11 set with `POST /companies/apply-due`. The consequence is stated rather
 * than hidden: until something calls it on a timer, a queued email waits.
 *
 * **It does not claim delivery it did not perform.** The adapter reports whether it delivers real
 * mail, and that flag is on every outcome and in every audit event. With the default logging
 * adapter, "delivered" means "handed to the adapter, which recorded it and sent nothing".
 *
 * ## Why the payload carries no address and no content
 *
 * An outbox row is long-lived, widely readable working state. The payload is a notification id;
 * the recipient's address and the message body are read here, from the services that own them.
 * The Prompt 10 rule was "never a token or a credential" — an email address in a queue is not a
 * credential, but it is personal data sitting somewhere nobody is thinking about, and reading it
 * at dispatch time costs one query.
 */
@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly users: UserRepository,
    private readonly email: EmailAdapter,
    private readonly auditEvents: AuditEventService,
  ) {}

  /** Claim what is due and try to deliver it. Safe to call concurrently — `SKIP LOCKED`. */
  async runOnce(limit = 20): Promise<DispatchOutcome> {
    const claimed = await this.outbox.claimDue(limit);
    const adapter = this.email.describe();

    let delivered = 0;
    let failed = 0;
    let skipped = 0;

    for (const message of claimed) {
      if (message.topic !== OUTBOX_TOPICS.notificationEmail) {
        // Another topic's row. It was claimed by the same query, so its attempt counter has
        // moved — which is why this is reported rather than silently ignored: a growing skipped
        // count means a topic has a producer and no consumer, and that is worth seeing.
        skipped += 1;
        continue;
      }

      try {
        await this.deliver(message);
        await this.outbox.markDelivered(message.id);
        delivered += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        const after = await this.outbox.markFailed(message.id, reason);
        failed += 1;

        if (after.state === 'DeadLettered') {
          // Worth its own log line at error level: the retry budget is exhausted and nobody is
          // going to try again. The row is kept, which is how somebody finds it.
          this.logger.error(
            `Notification email dead-lettered after ${after.attempts} attempts: ${reason}`,
          );
        }
      }
    }

    return { claimed: claimed.length, delivered, failed, skipped, adapter };
  }

  private async deliver(message: OutboxMessage): Promise<void> {
    const payload = message.payload as { notificationId?: string; tenantId?: string };
    const notificationId = payload.notificationId;
    const tenantId = payload.tenantId ?? message.tenantId;

    if (!notificationId || !tenantId) {
      // A malformed payload will never succeed, so failing it fast lets the retry budget
      // dead-letter it rather than spending eight attempts on something unsendable.
      throw new Error('A notification email message must carry a notificationId and a tenantId.');
    }

    const notification = await this.prisma.runInTenantTransaction({ tenantId } as TenantScope, () =>
      this.prisma.client.notification.findFirst({ where: { tenantId, id: notificationId } }),
    );

    if (!notification) {
      throw new Error(`Notification ${notificationId} no longer exists.`);
    }

    const recipient = await this.users.findByIdForPlatform(notification.recipientUserId);
    if (!recipient) {
      throw new Error(`Recipient ${notification.recipientUserId} no longer exists.`);
    }

    // Prompt 12 gives a person with no real work address a placeholder at
    // `person.uboss.invalid`, deliberately undeliverable so nothing pretends to reach them. Fail
    // rather than send: a dead-lettered row saying "no address" is findable, and a mail to an
    // invalid domain is a bounce nobody sees.
    if (recipient.email.endsWith('.invalid')) {
      throw new Error(
        'That person has no real email address — only the placeholder created when they were ' +
          'added by identifier. There is nowhere to send this.',
      );
    }

    const definition = notificationKind(notification.kind);
    const result = await this.email.send({
      to: recipient.email,
      subject:
        notification.severity === 'Critical'
          ? `[Action required] ${notification.title}`
          : notification.title,
      text:
        `${notification.body}\n\n` +
        `Open it: ${notification.deepLink}\n\n` +
        (notification.requiresAcknowledgement
          ? 'This alert needs your acknowledgement. Opening it is not enough.\n'
          : '') +
        (definition?.alwaysMandatory
          ? 'You are receiving this because security alerts cannot be turned off.\n'
          : ''),
      reference: `notification:${notification.id}`,
    });

    await this.prisma.runInTenantTransaction({ tenantId } as TenantScope, () =>
      this.auditEvents.appendWithinCurrentScope(tenantId, {
        action: 'notification.email_dispatched',
        resourceType: 'notification',
        resourceId: notification.id,
        summary: `Handed to the ${result.channel} channel for ${maskEmail(recipient.email)}.`,
        metadata: {
          channel: result.channel,
          providerMessageId: result.providerMessageId,
          // The distinction the whole adapter design exists to preserve.
          deliversRealMail: this.email.describe().deliversRealMail,
          kind: notification.kind,
          severity: notification.severity,
        },
      }),
    );
  }
}
