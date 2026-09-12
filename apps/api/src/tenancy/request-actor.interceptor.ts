import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import type { AuthenticatedActor } from '../request-context/authenticated-actor.js';
import { withActor } from '../request-context/request-context.js';

/**
 * Re-establishes the verified actor into the ambient request context for the handler.
 *
 * Nest calls guards, then interceptors, then the handler — and each on a separate call stack, so
 * an `AsyncLocalStorage` scope opened inside `canActivate` does not reach the handler. The guard
 * therefore attaches the verified actor to the request object, and this interceptor puts it back
 * into the context around the handler's execution.
 *
 * Ordering matters: this must run **after** `TenantGuard`, which Nest guarantees for a global
 * interceptor paired with a global guard.
 */
@Injectable()
export class RequestActorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { ubossActor?: AuthenticatedActor }>();

    const actor = request.ubossActor;
    if (!actor) {
      // An anonymous route: leave the context as the middleware created it.
      return next.handle();
    }

    return withActor(actor, () => next.handle());
  }
}
