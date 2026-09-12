import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';

import {
  ActorResolver,
  ANONYMOUS_PRINCIPAL,
  type ResolvedPrincipal,
} from '../request-context/actor-resolver.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';
import { SessionService } from './session.service.js';

/**
 * The real `ActorResolver`: it authenticates a request from its session cookie.
 *
 * This is the single integration point Prompt 4 left open. The guard, request context and RLS
 * wiring are unchanged — only the resolver was swapped.
 */
@Injectable()
export class SessionActorResolver extends ActorResolver {
  private readonly logger = new Logger(SessionActorResolver.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {
    super();
  }

  async resolve(request: Request): Promise<ResolvedPrincipal> {
    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    const token = cookies?.[this.sessions.cookieName];

    const validation = await this.sessions.validate(token);

    switch (validation.outcome) {
      case 'valid':
        return validation.isPlatformActor
          ? {
              kind: 'platform',
              userId: validation.userId,
              ubossUniqueId: validation.ubossUniqueId,
            }
          : {
              kind: 'person',
              userId: validation.userId,
              ubossUniqueId: validation.ubossUniqueId,
            };

      case 'idle-expired':
      case 'absolute-expired':
        // Recorded so a support conversation can distinguish "signed out by policy" from
        // "something broke" — the difference matters to the person asking.
        await this.securityEvents.record({
          action: SECURITY_ACTIONS.sessionExpired,
          actorUserId: validation.userId,
          resourceType: 'session',
          resourceId: validation.sessionId,
          summary:
            validation.outcome === 'idle-expired'
              ? 'Session ended: idle timeout.'
              : 'Session ended: absolute expiry reached.',
          metadata: { reason: validation.outcome },
        });
        return ANONYMOUS_PRINCIPAL;

      case 'unknown':
        // A cookie that names no live session: revoked, or simply stale. Not logged as an event,
        // because a stale cookie in a browser is routine and would flood the trail.
        return ANONYMOUS_PRINCIPAL;

      case 'absent':
        return ANONYMOUS_PRINCIPAL;
    }
  }
}

/**
 * Resolves an actor from the session cookie, falling back to the development header resolver
 * when one is configured.
 *
 * The order matters: a real session always wins. The development resolver is only consulted when
 * no valid session cookie is present, and it is only ever constructed when
 * `isDevHeaderResolverPermitted()` allows it — which is never in production.
 */
export class CompositeActorResolver extends ActorResolver {
  constructor(
    private readonly session: SessionActorResolver,
    private readonly fallback: ActorResolver | undefined,
  ) {
    super();
  }

  async resolve(request: Request): Promise<ResolvedPrincipal> {
    const fromSession = await this.session.resolve(request);
    if (fromSession.kind !== 'anonymous') {
      return fromSession;
    }
    return this.fallback ? this.fallback.resolve(request) : ANONYMOUS_PRINCIPAL;
  }
}
