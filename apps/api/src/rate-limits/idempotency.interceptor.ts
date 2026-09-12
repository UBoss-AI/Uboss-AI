import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { firstValueFrom, from, type Observable } from 'rxjs';

import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_METHODS } from '@uboss/types';

import { isTenantActor, type AuthenticatedActor } from '../request-context/authenticated-actor.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * Honours `Idempotency-Key` on mutating requests — Prompt 40.
 *
 * ## Opt-in, and why it has to be
 *
 * A key is used only when the client sends one. Generating keys server-side is impossible — the
 * server cannot tell a retry from a second identical action, which is the entire question — and
 * requiring the header would break every existing client for the sake of a protection they have
 * not asked for.
 *
 * That is the same contract every payment API uses, and for the same reason: only the caller knows
 * whether two identical requests are one intention or two.
 *
 * ## Ordering
 *
 * Registered **after** the rate limiter, so it is inside it. A throttled request must not claim a
 * key: the client will retry with that same key, and finding it claimed by a request that was
 * never served would report `InFlight` forever.
 *
 * ## Why the observable is awaited rather than tapped
 *
 * Because the outcome has to be recorded either way. `tap` sees a value and an error but makes the
 * "release the claim on failure" path awkward to express, and a claim that leaks on an exception is
 * a key the client can never reuse — a bug that only appears when something else has already gone
 * wrong, which is the worst time to have it.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { ubossActor?: AuthenticatedActor }>();

    const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER];
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (key === '') return next.handle();

    if (!IDEMPOTENT_METHODS.includes(request.method.toUpperCase())) {
      // A key on a PUT or DELETE is harmless and ignored rather than refused: those are already
      // idempotent by construction, so honouring the header would add a table write and change
      // nothing about the outcome.
      return next.handle();
    }

    const actor = request.ubossActor;
    if (actor === undefined || actor.kind === 'anonymous') {
      // A key needs an owner. Anonymous keys would share one namespace across every caller, which
      // is the cross-tenant replay the unique index exists to prevent.
      return next.handle();
    }

    const userId = actor.userId;
    const tenantId = isTenantActor(actor) ? actor.tenantId : null;

    return from(this.run({ context, next, key, userId, tenantId, request }));
  }

  private async run(input: {
    context: ExecutionContext;
    next: CallHandler;
    key: string;
    userId: string;
    tenantId: string | null;
    request: Request;
  }): Promise<unknown> {
    const { key, userId, tenantId, request } = input;

    // A key longer than the column would be truncated on write and then never match on read, so
    // the client's retries would each do the work again — silently. Refused instead.
    if (key.length > 200) {
      throw new ConflictException(
        'That idempotency key is too long. Use up to 200 characters — a UUID is the usual choice.',
      );
    }

    const outcome = await this.idempotency.begin({
      key,
      userId,
      tenantId,
      method: request.method.toUpperCase(),
      path: request.path,
      body: request.body,
    });

    const response = input.context.switchToHttp().getResponse<Response>();

    if (outcome.kind === 'Conflict') {
      throw IdempotencyService.conflict(outcome.reason);
    }

    if (outcome.kind === 'InFlight') {
      // 409 rather than waiting. Holding the connection open on another request's outcome would
      // tie up a worker and still have to give up eventually.
      throw new ConflictException(
        'That request is still being processed. Retry with the same key in a moment — it will ' +
          'not be applied twice.',
      );
    }

    if (outcome.kind === 'Replay') {
      response.status(outcome.statusCode);
      // So a client can tell a replay from the original. Without it, a retry that succeeded looks
      // identical to a first attempt, and "did my first request work?" stays unanswered.
      response.setHeader('Idempotent-Replay', 'true');
      return outcome.body;
    }

    try {
      const value = await firstValueFrom(input.next.handle());
      await this.idempotency.finish({
        key,
        userId,
        tenantId,
        statusCode: response.statusCode,
        body: value,
      });
      return value;
    } catch (error) {
      // Release the claim. A remembered failure would replay for twenty-four hours and the client
      // could never succeed — see `abandon`.
      await this.idempotency.abandon({ key, userId, tenantId });
      throw error;
    }
  }
}
