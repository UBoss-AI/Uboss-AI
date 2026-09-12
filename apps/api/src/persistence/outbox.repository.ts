import { Injectable } from '@nestjs/common';

import type { OutboxMessage, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/**
 * Outbox topics. A closed set, so a dispatcher can exhaustively switch on it and a typo cannot
 * invent a message nothing handles.
 */
export const OUTBOX_TOPICS = {
  companyActivationInvitation: 'company.activation_invitation',
  userInvitation: 'user.invitation',
  userInvitationResent: 'user.invitation_resent',
  /** Prompt 15. The first topic with a dispatcher: see `NotificationDispatcherService`. */
  notificationEmail: 'notification.email',
  /** A batched summary for somebody whose preference asks for one rather than each event. */
  notificationDigest: 'notification.digest',
} as const;

export type OutboxTopic = (typeof OUTBOX_TOPICS)[keyof typeof OUTBOX_TOPICS];

/** How many delivery attempts before a message is dead-lettered rather than retried forever. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/**
 * The transactional outbox.
 *
 * ## What it is for
 *
 * Provisioning is one transaction. Sending the activation email inside it would break it in one
 * of two ways: an SMTP round-trip holding a database transaction open, or a mail that goes out
 * and is then rolled back — leaving a customer holding an activation link for a company that
 * does not exist.
 *
 * So the *intent to send* is written in the same transaction as the work, and delivery happens
 * afterwards. The property that buys is exactly the one provisioning needs: **no message is ever
 * sent for work that rolled back, and no committed work is ever left without its message.**
 *
 * ## Deliberately not self-scoping
 *
 * Every other repository since Prompt 6 declares its own tenant scope (ADR-037). This one does
 * not, and the reason is the whole point of an outbox: `enqueue` **must** join the caller's
 * transaction, because a row written in its own transaction would commit even when the work
 * rolled back. Opening a scope here would open a transaction, and that would destroy the
 * guarantee.
 *
 * The reader methods do scope themselves, because they are ordinary reads with no such
 * constraint.
 *
 * ## No dispatcher exists yet
 *
 * Email delivery is the notifications module (Prompt 28). Rows accumulate as `Pending`, the
 * Master Console can see them, and `claimDue`/`markDelivered`/`markFailed` exist and are tested
 * so the dispatcher is a consumer of a working queue rather than a queue plus a dispatcher
 * written together and never exercised separately. Saying "mail is being sent" when nothing
 * sends it would be the alternative.
 */
@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write the intent to send, inside the caller's transaction.
   *
   * `idempotencyKey` is unique, and that uniqueness is what makes a retried provisioning safe:
   * the second attempt's insert collides, its transaction rolls back, and nothing is duplicated.
   * The constraint lives here rather than in a separate idempotency table because this row is
   * already written in the same transaction, so there is nothing extra to keep in step.
   *
   * **The payload must never carry a token or a credential.** An activation payload carries the
   * invitation's *id*; the dispatcher reads the one-time token through the service that owns it.
   * An outbox row is long-lived, widely readable working state, and a token in one would be a
   * credential at rest in a queue.
   */
  async enqueue(input: {
    topic: OutboxTopic;
    tenantId?: string | null;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    availableAt?: Date;
  }): Promise<OutboxMessage> {
    return this.prisma.client.outboxMessage.create({
      data: {
        topic: input.topic,
        tenantId: input.tenantId ?? null,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload as Prisma.InputJsonValue,
        ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
      },
    });
  }

  /** Look up a previous enqueue by its idempotency key, to detect an honest retry. */
  async findByIdempotencyKey(idempotencyKey: string): Promise<OutboxMessage | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.outboxMessage.findUnique({ where: { idempotencyKey } }),
    );
  }

  /**
   * Claim messages due for delivery.
   *
   * `InFlight` is a distinct state from `Pending` on purpose: a dispatcher that crashes
   * mid-delivery leaves its rows visibly claimed rather than looking un-started, so an operator
   * can tell "nothing has tried this" from "something tried and died".
   *
   * `SKIP LOCKED` so two dispatchers can run without either waiting on the other's rows — the
   * standard queue pattern, and the reason this is raw SQL rather than a Prisma `updateMany`,
   * which cannot express it.
   */
  async claimDue(limit = 20): Promise<OutboxMessage[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.$queryRawUnsafe<OutboxMessage[]>(
        `UPDATE "outbox_messages" SET
           "state" = 'InFlight',
           "claimed_at" = NOW(),
           "attempts" = "attempts" + 1,
           "updated_at" = NOW(),
           "row_version" = "row_version" + 1
         WHERE "id" IN (
           SELECT "id" FROM "outbox_messages"
           WHERE "state" IN ('Pending', 'InFlight')
             AND "available_at" <= NOW()
             AND "attempts" < ${OUTBOX_MAX_ATTEMPTS}
           ORDER BY "available_at" ASC
           LIMIT ${Math.max(1, Math.min(limit, 200))}
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
      ),
    );
  }

  async markDelivered(id: string): Promise<void> {
    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.outboxMessage.update({
        where: { id },
        data: { state: 'Delivered', deliveredAt: new Date(), version: { increment: 1 } },
      }),
    );
  }

  /**
   * Record a failed delivery, with exponential backoff, and dead-letter past the retry budget.
   *
   * A dead-lettered message is **kept**, not deleted: "we failed to send this customer their
   * activation link" is exactly the thing somebody needs to find, and a deleted row cannot be
   * found. It is also why `DeadLettered` is terminal rather than looping — a queue that retries
   * forever hides a permanent failure behind noise.
   */
  async markFailed(id: string, error: string): Promise<OutboxMessage> {
    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.prisma.client.outboxMessage.findUnique({ where: { id } });
      const attempts = existing?.attempts ?? 1;
      const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;

      return this.prisma.client.outboxMessage.update({
        where: { id },
        data: {
          state: exhausted ? 'DeadLettered' : 'Failed',
          lastError: error.slice(0, 1000),
          // 1m, 2m, 4m, 8m… capped. Fast enough that a transient outage self-heals, slow enough
          // that a broken provider is not hammered.
          availableAt: new Date(Date.now() + Math.min(2 ** attempts, 512) * 60_000),
          version: { increment: 1 },
        },
      });
    });
  }

  /** What is waiting, for the Master Console to show. Platform-plane view across companies. */
  async listForPlatform(filter: {
    state?: OutboxMessage['state'] | undefined;
    tenantId?: string | undefined;
    take?: number | undefined;
  }): Promise<OutboxMessage[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.outboxMessage.findMany({
        where: {
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(filter.tenantId === undefined ? {} : { tenantId: filter.tenantId }),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(filter.take ?? 50, 200),
      }),
    );
  }

  /** Counts by state, for the dashboard. A growing `Pending` count is an operational signal. */
  async countsByState(): Promise<Record<string, number>> {
    const grouped = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.outboxMessage.groupBy({ by: ['state'], _count: { _all: true } }),
    );
    return Object.fromEntries(grouped.map((row) => [row.state, row._count._all]));
  }
}
