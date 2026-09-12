import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

import { routeIsUnlimited } from '@uboss/types';

import { isTenantActor, type AuthenticatedActor } from '../request-context/authenticated-actor.js';
import { RateLimitService } from './rate-limit.service.js';

/**
 * The per-user and per-tenant API rate limiter — Prompt 40.
 *
 * ## Why an interceptor and not a guard
 *
 * Because it needs to know who is calling, and the actor is not known until `TenantGuard` has
 * verified it. Nest runs **every** guard before **any** interceptor, so by the time this runs,
 * `request.ubossActor` is populated — and a guard registered ahead of `TenantGuard` would have
 * seen nothing and limited everybody as if they were anonymous.
 *
 * That ordering also gives the right *semantics*: an unauthenticated request that fails
 * authentication never reaches a limiter keyed by identity, which is correct — an anonymous flood
 * is the proxy's problem (`WAF_ASSUMPTIONS`), and sign-in has had its own lockout since Prompt 5.
 *
 * ## What it does not do
 *
 * It does not rate-limit by IP address. `X-Forwarded-For` is set by whatever is in front of the
 * application and can be forged when nothing is, so an IP limiter here would be a control whose
 * strength depended on infrastructure this code cannot see. Identity is the thing the application
 * knows for certain, and it is the layer a proxy cannot police.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(private readonly limits: RateLimitService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { ubossActor?: AuthenticatedActor }>();

    // The probes and the way out. See `UNLIMITED_ROUTES` for why each one is there.
    if (routeIsUnlimited(request.path)) return next.handle();

    const actor = request.ubossActor;
    const userId =
      actor === undefined || actor.kind === 'anonymous' ? null : (actor.userId ?? null);
    const tenantId = actor !== undefined && isTenantActor(actor) ? actor.tenantId : null;

    const outcome = await this.limits.check({ userId, tenantId });
    const response = http.getResponse<Response>();

    // Set on allowed responses too. A client that can see it is running out of allowance can slow
    // down before being refused, which is the difference between a rate limit that shapes traffic
    // and one that only punishes it.
    response.setHeader('RateLimit-Limit', String(outcome.limit));
    response.setHeader('RateLimit-Remaining', String(outcome.remaining));

    if (outcome.allowed || outcome.refusal === undefined) return next.handle();

    response.setHeader('Retry-After', String(outcome.refusal.retryAfterSeconds));

    /**
     * A business-readable 429, as the prompt asks for.
     *
     * `message` is the sentence a screen can show a person unchanged — it says whether this is
     * them or their company, and whether to wait or to call somebody. `scope`, `limit` and
     * `retryAfterSeconds` are for the client; `error` keeps the shape every other UBoss error has,
     * so a client's existing error handling does not need a special case for this one.
     */
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: outcome.refusal.message,
        scope: outcome.refusal.scope,
        limit: outcome.refusal.limit,
        retryAfterSeconds: outcome.refusal.retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
