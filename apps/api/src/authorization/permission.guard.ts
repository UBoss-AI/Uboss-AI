import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { UserType } from '@uboss/types';

import type { Request } from 'express';

import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { isTenantActor, type AuthenticatedActor } from '../request-context/authenticated-actor.js';
import { AuthorizationService } from './authorization.service.js';
import {
  ALLOW_ANY_PERMISSION_KEY,
  REQUIRE_PERMISSION_KEY,
  REQUIRE_USER_TYPE_KEY,
  type RequiredPermission,
} from './authorization.decorators.js';

/**
 * Enforces `@RequirePermission`, `@RequireAnyPermission` and `@RequireUserType`.
 *
 * ## Why this is a second guard rather than more logic in `TenantGuard`
 *
 * They answer different questions and fail for different reasons. `TenantGuard` decides *may this
 * person be in this company at all* — membership, company lifecycle state, account state — and it
 * denies by default, so a route with no tenancy policy never reaches here. This guard decides
 * *what they may do*, and only ever runs on a route that has already passed the first.
 *
 * Keeping them separate means the deny-by-default property of the first is untouched: adding
 * authorization cannot accidentally open a route that was previously closed, because a route with
 * no `@RequirePermission` is simply not permission-checked — it is still tenancy-checked, and it
 * still has to declare a tenancy policy to exist at all.
 *
 * ## What it deliberately does not do
 *
 * No resource-level check. A guard runs before the handler and cannot know which row is being
 * touched, so scope and separation of duties are the handler's `assertCanOnResource`. Pretending
 * otherwise — passing a route parameter as a resource id and checking that — would authorize the
 * *id in the URL* rather than the row that gets loaded, which is worse than not checking.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.metadata<readonly RequiredPermission[]>(context, REQUIRE_PERMISSION_KEY);
    const anyOf = this.metadata<readonly RequiredPermission[]>(context, ALLOW_ANY_PERMISSION_KEY);
    const userTypes = this.metadata<readonly UserType[]>(context, REQUIRE_USER_TYPE_KEY);

    // No authorization metadata: nothing to enforce. The route is still tenancy-checked by
    // `TenantGuard`, which denies anything with no policy at all.
    if (!required && !anyOf && !userTypes) {
      return true;
    }

    /**
     * The actor comes from the **request**, not from `getActor()`.
     *
     * Nest runs guards, then interceptors, then the handler, each on its own call stack — so an
     * `AsyncLocalStorage` scope opened by `RequestActorInterceptor` does not reach a guard.
     * `TenantGuard` therefore attaches the verified actor to the request, and that is what a
     * second guard has to read. Calling `getActor()` here returns anonymous and refuses
     * everybody, which is exactly what it did before this comment existed.
     */
    const request = context
      .switchToHttp()
      .getRequest<Request & { ubossActor?: AuthenticatedActor }>();
    const actor = request.ubossActor;

    if (!actor || actor.kind === 'anonymous') {
      // Reachable only if this guard is ever registered ahead of `TenantGuard`, which would be a
      // wiring mistake rather than a request an anonymous caller can make.
      throw new ForbiddenException('Authentication is required.');
    }

    // A tenant actor's scope comes from its verified membership. A platform actor reaching a
    // permission-checked route is evaluated against the platform permission set, and
    // `contextFor` returns that when there is no membership.
    const scope = isTenantActor(actor)
      ? tenantScopeForPlatformOperation(actor.tenantId)
      : tenantScopeForPlatformOperation(actor.userId);

    const authorizationContext = isTenantActor(actor)
      ? await this.authorization.contextFor(scope, actor.userId)
      : await this.authorization.platformContext(actor.userId);

    if (userTypes && !userTypes.includes(authorizationContext.userType)) {
      throw new ForbiddenException(
        'This is not available to your kind of account in this company.',
      );
    }

    if (required) {
      for (const permission of required) {
        const decision = await this.authorization.authorize(authorizationContext, permission);
        if (!decision.allowed) {
          this.logger.warn(
            `Refused ${permission.action} on ${permission.module} for user ` +
              `${authorizationContext.userId}: ${decision.reason}`,
          );
          // The message is the engine's, which names the dimension that blocked — "your role does
          // not include Approve on this" rather than "forbidden". The trace is NOT included: it
          // describes the company's policy configuration.
          throw new ForbiddenException(decision.message);
        }
      }
    }

    if (anyOf && anyOf.length > 0) {
      const decisions = await Promise.all(
        anyOf.map((permission) => this.authorization.authorize(authorizationContext, permission)),
      );

      if (!decisions.some((decision) => decision.allowed)) {
        // The first denial's message, because they are all denials and the first is the one whose
        // permission the route lists first — which is the most likely one the caller expected.
        throw new ForbiddenException(decisions[0]?.message ?? 'You do not have access to that.');
      }
    }

    return true;
  }

  /** Handler metadata wins over controller metadata, so a route can tighten its class default. */
  private metadata<T>(context: ExecutionContext, key: string): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
  }
}
