import { createHash } from 'node:crypto';

import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { decideIdempotency, IDEMPOTENCY_WINDOW_HOURS, type IdempotencyOutcome } from '@uboss/types';

import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';

/** What the caller needs in order to identify a request. */
export interface IdempotencyRequest {
  key: string;
  userId: string;
  /** Null for a platform-plane request. */
  tenantId: string | null;
  method: string;
  path: string;
  body: unknown;
}

/**
 * Idempotency for retried mutating requests — Prompt 40.
 *
 * ## The problem this solves, precisely
 *
 * A client posts "start this run", the connection drops before the response arrives, and the
 * client retries. Without a key the run starts twice: two reservations against the budget, two
 * provider calls, two sets of output. The client cannot tell whether the first one worked, so *not*
 * retrying is equally wrong. There is no correct client behaviour without server support.
 *
 * ## Why the run engine's own idempotency is not enough
 *
 * `AgentRun` has had an idempotency key since Prompt 26, and it is what makes two scheduler
 * instances safe. But it is *derived* from the occurrence — a scheduled tick, a due instant — so it
 * only deduplicates work the server can name in advance. A client-initiated POST has no natural
 * occurrence: two "create this objective" requests a second apart are indistinguishable unless the
 * client says they are the same one. That is what the header is for, and this is the layer that
 * reads it.
 *
 * So: the engine's key protects the *scheduler*, this protects the *client*, and neither replaces
 * the other.
 *
 * ## Why the record is written before the work
 *
 * The insert is the claim. If it were written afterwards, two concurrent retries would both find
 * nothing, both do the work, and both then try to record it — the unique index would catch the
 * second one only after the damage. Claiming first turns the race into a lost insert, which is
 * exactly what `InFlight` reports.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * Hash what makes a request the same request.
   *
   * Method, path and body — not headers, not the correlation id, not the time. Two retries of one
   * logical request differ in all of those and are the same request; two different requests that
   * happen to share a key differ in at least one of these three.
   */
  static hash(input: { method: string; path: string; body: unknown }): string {
    // `JSON.stringify` is stable enough here because the body has already been through the
    // validation pipe, which reconstructs it from the DTO in declaration order. A body that
    // round-trips to different JSON would read as a conflict, which fails safe: it refuses rather
    // than replaying the wrong answer.
    const canonical = `${input.method} ${input.path} ${JSON.stringify(input.body ?? null)}`;
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Claim the key, or say what to do instead.
   *
   * Returns `Fresh` having inserted the claim — the caller must then call `finish` or `abandon`.
   */
  async begin(request: IdempotencyRequest): Promise<IdempotencyOutcome> {
    const requestHash = IdempotencyService.hash(request);
    const scopeKey = request.tenantId ?? 'platform';

    const existing = await this.inScope(request.tenantId, async () =>
      this.prisma.client.idempotencyRecord.findFirst({
        where: { scopeKey, userId: request.userId, key: request.key },
        select: { requestHash: true, statusCode: true, responseBody: true, expiresAt: true },
      }),
    );

    // An expired record is not a replay. Deliberately treated as absent rather than refused: a
    // key reused a week later is a new request, and pretending to remember forever would make
    // this table grow without bound for no benefit anybody can name.
    const live = existing === null || existing.expiresAt.getTime() <= Date.now() ? null : existing;

    const outcome = decideIdempotency({
      existing:
        live === null
          ? null
          : {
              requestHash: live.requestHash,
              statusCode: live.statusCode,
              body: live.responseBody,
            },
      requestHash,
    });

    if (outcome.kind === 'Conflict') {
      // Recorded, because this is the one idempotency outcome that is not a retry: either a client
      // is generating keys wrongly — in which case somebody's requests are being discarded
      // somewhere — or somebody is probing what a replay does. Outside any transaction, so the
      // refusal below cannot roll the record back with it (the mistake of S-256 and S-282).
      await this.report(request);
      return outcome;
    }

    if (outcome.kind !== 'Fresh') return outcome;

    const now = new Date();
    try {
      await this.inScope(request.tenantId, async () => {
        /**
         * Clear an expired claim before making a new one.
         *
         * **Without this, a key becomes unusable forever rather than for twenty-four hours.** The
         * read above treats an expired record as absent, which is right — a key reused a week
         * later is a new request — but the row is still there, so the insert trips the unique
         * index and the caller is told `InFlight` by a request that finished last week. Found by
         * the test that reuses a key after its window.
         *
         * Scoped to this exact key rather than to everything expired: a general sweep belongs in
         * `sweep()`, on a schedule, and doing it here would make one client's request pay for
         * every other client's litter.
         *
         * In the same scope call as the create, so for a tenant request the two are one
         * transaction: a concurrent retry either sees the old row or the new one, never neither.
         */
        await this.prisma.client.idempotencyRecord.deleteMany({
          where: { scopeKey, userId: request.userId, key: request.key, expiresAt: { lt: now } },
        });

        await this.prisma.client.idempotencyRecord.create({
          data: {
            tenantId: request.tenantId,
            scopeKey,
            userId: request.userId,
            key: request.key,
            method: request.method,
            path: request.path.slice(0, 500),
            requestHash,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_WINDOW_HOURS * 3_600_000),
          },
        });
      });
    } catch (error) {
      // Lost the race to another retry of the same request. The unique index is the arbiter, and
      // the loser reports `InFlight` — which is the truth: the work is happening, in the request
      // that won.
      if (isUniqueViolation(error)) return { kind: 'InFlight' };
      throw error;
    }

    return { kind: 'Fresh' };
  }

  /** Remember the response, so a retry replays it. */
  async finish(input: {
    key: string;
    userId: string;
    tenantId: string | null;
    statusCode: number;
    body: unknown;
  }): Promise<void> {
    const scopeKey = input.tenantId ?? 'platform';
    try {
      await this.inScope(input.tenantId, async () =>
        this.prisma.client.idempotencyRecord.updateMany({
          where: { scopeKey, userId: input.userId, key: input.key },
          data: {
            statusCode: input.statusCode,
            // `null` is refused on a nullable Json column, so an empty response is stored as JSON
            // null rather than as an absent value — and a 204 is a real outcome worth replaying.
            responseBody: (input.body ?? null) as never,
            completedAt: new Date(),
          },
        }),
      );
    } catch (error) {
      // The work succeeded; only the memory of it failed. Turning that into an error would fail a
      // request that actually worked, which is worse than losing the replay.
      this.logger.warn(
        `The response for idempotency key ${input.key} could not be stored: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Drop the claim, because the work failed.
   *
   * **A failed request must not be remembered.** Storing a 500 against the key would mean every
   * retry replays the failure for twenty-four hours — the client could never succeed, and the
   * cause would be a feature meant to help it. Only a completed response is worth replaying; a
   * failure is worth retrying, which is the whole point of retrying.
   */
  async abandon(input: { key: string; userId: string; tenantId: string | null }): Promise<void> {
    const scopeKey = input.tenantId ?? 'platform';
    try {
      await this.inScope(input.tenantId, async () =>
        this.prisma.client.idempotencyRecord.deleteMany({
          where: { scopeKey, userId: input.userId, key: input.key, statusCode: null },
        }),
      );
    } catch (error) {
      this.logger.debug(
        `Could not release idempotency key ${input.key}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Delete expired records.
   *
   * The eighth job waiting on the Prompt 26 business-cron scheduler. Exposed as a method with a
   * route behind it, so it is reachable and tested rather than a comment about what should happen.
   */
  async sweep(now = new Date()): Promise<{ deleted: number }> {
    const result = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } }),
    );
    return { deleted: result.count };
  }

  /** Throw the business-readable conflict for a key reused with different content. */
  static conflict(reason: string): ConflictException {
    return new ConflictException(reason);
  }

  /**
   * Run a read or write in the right plane.
   *
   * A tenant request inside its own tenant scope, a platform request as a platform operation. The
   * RLS policy on this table is the strict one, so a platform-plane record is invisible to a
   * tenant reader — which is the point, since it holds a platform operator's response body.
   */
  private async inScope<T>(tenantId: string | null, work: () => Promise<T>): Promise<T> {
    if (tenantId === null) return this.prisma.runAsPlatformOperation(work);
    return this.prisma.runInTenantTransaction(tenantScopeForPlatformOperation(tenantId), work);
  }

  private async report(request: IdempotencyRequest): Promise<void> {
    try {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.idempotencyKeyReused,
        actorUserId: request.userId,
        ...(request.tenantId === null ? {} : { tenantId: request.tenantId }),
        resourceType: 'idempotency-key',
        summary:
          'An idempotency key was replayed with different content, so neither request was ' +
          'applied. Either a client is generating keys wrongly or somebody is probing what a ' +
          'replay does.',
        metadata: { method: request.method, path: request.path.slice(0, 200) },
      });
    } catch (error) {
      this.logger.warn(
        `A reused-key security event could not be recorded: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}
