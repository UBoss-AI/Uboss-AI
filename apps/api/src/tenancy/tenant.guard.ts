import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ActorResolver } from '../request-context/actor-resolver.js';
import type { AuthenticatedActor } from '../request-context/authenticated-actor.js';
import { getCorrelationId } from '../request-context/request-context.js';
import {
  ALLOW_ANONYMOUS_KEY,
  AUTHENTICATED_KEY,
  PLATFORM_ONLY_KEY,
  TENANT_SCOPED_KEY,
} from './tenancy.decorators.js';
import { TenantContextService } from './tenant-context.service.js';
import { isTenantId } from '../persistence/tenant-context.js';
import { effectiveCapability, isWriteMethod } from './tenant-lifecycle.js';

/** Header a client uses to choose which company workspace a request applies to. */
export const WORKSPACE_HEADER = 'x-uboss-workspace';

/**
 * Enforces the tenancy contract on every request.
 *
 * Denies by default: a route with none of `@AllowAnonymous`, `@PlatformOnly` or
 * `@TenantScoped` is refused. A forgotten decorator therefore produces a 403 that someone
 * notices, rather than an unintentionally open endpoint that nobody does.
 *
 * For a tenant-scoped route it:
 *   1. resolves the authenticated principal through the `ActorResolver` seam (Prompt 5 supplies
 *      the real one; the default authenticates nobody);
 *   2. reads the *requested* workspace from the route parameter or header — treating it purely
 *      as a request, never as proof;
 *   3. verifies a membership for that person and workspace **in the database**;
 *   4. enforces the company's lifecycle state, including blocking writes to a read-only company;
 *   5. replaces the request's actor with a verified `TenantActor`, which is the only thing
 *      downstream services will accept.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly actorResolver: ActorResolver,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(ALLOW_ANONYMOUS_KEY, targets)) {
      return true;
    }

    const platformOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_ONLY_KEY, targets);
    const tenantScoped = this.reflector.getAllAndOverride<boolean>(TENANT_SCOPED_KEY, targets);
    const authenticated = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets);

    if (!platformOnly && !tenantScoped && !authenticated) {
      // Deny-by-default. Named explicitly so the fix is obvious in the log.
      this.logger.error(
        `Route ${context.getClass().name}.${context.getHandler().name} has no tenancy ` +
          'decorator. Add @AllowAnonymous, @Authenticated, @PlatformOnly or @TenantScoped.',
      );
      throw new ForbiddenException('This route has no tenancy policy and is refused by default.');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const principal = await this.actorResolver.resolve(request);

    if (principal.kind === 'anonymous') {
      throw new UnauthorizedException('Authentication is required.');
    }

    if (authenticated && !platformOnly && !tenantScoped) {
      // Signed in, no workspace required. A platform actor is admitted too: Active Sessions and
      // Logout All Devices are person-level and belong to everyone with an account.
      return this.continueWith(
        context,
        principal.kind === 'platform'
          ? {
              kind: 'platform',
              userId: principal.userId,
              ubossUniqueId: principal.ubossUniqueId,
            }
          : { kind: 'user', userId: principal.userId, ubossUniqueId: principal.ubossUniqueId },
      );
    }

    if (platformOnly) {
      if (principal.kind !== 'platform') {
        throw new ForbiddenException(
          'This is the UBoss Master Console. Your account is scoped to a company workspace.',
        );
      }
      return this.continueWith(context, {
        kind: 'platform',
        userId: principal.userId,
        ubossUniqueId: principal.ubossUniqueId,
      });
    }

    // --- tenant-scoped from here ---
    if (principal.kind === 'platform') {
      // A platform actor is not implicitly a member of every company. Acting inside a tenant
      // must go through an explicit, audited support path, which does not exist yet.
      throw new ForbiddenException(
        'A platform account cannot act inside a company workspace without an explicit ' +
          'membership.',
      );
    }

    const requested = this.readRequestedWorkspace(request);
    if (!requested) {
      throw new ForbiddenException(
        `No workspace was selected. Supply one via the ${WORKSPACE_HEADER} header.`,
      );
    }

    if (!isTenantId(requested)) {
      // Rejected before it reaches the database, so a malformed value cannot become a query.
      throw new ForbiddenException('The selected workspace is not a valid workspace id.');
    }

    const membership = await this.tenantContext.verifyMembership(principal.userId, requested);

    if (!membership) {
      // Deliberately identical to the message for a workspace that does not exist: a caller
      // must not be able to tell "no such company" from "not your company".
      this.logger.warn(
        `Denied workspace ${requested} for user ${principal.userId} — no membership ` +
          `(correlation ${getCorrelationId() ?? 'none'})`,
      );
      throw new ForbiddenException('You do not have access to the selected workspace.');
    }

    // Both the company's lifecycle state and the person's account state are enforced, taking
    // whichever is more restrictive — see effectiveCapability.
    const capability = effectiveCapability(membership.lifecycleState, membership.accountState);

    if (!capability.canAccess) {
      throw new ForbiddenException(capability.reason);
    }

    if (!capability.canWrite && isWriteMethod(request.method)) {
      throw new ForbiddenException(capability.reason);
    }

    return this.continueWith(context, {
      kind: 'tenant',
      userId: principal.userId,
      ubossUniqueId: principal.ubossUniqueId,
      tenantId: membership.tenantId,
      membershipId: membership.membershipId,
    });
  }

  /**
   * Reads the requested workspace. A route parameter wins over the header so a URL like
   * `/workspaces/:tenantId/...` stays self-describing.
   *
   * Whatever this returns is a *request*, not a credential — step 3 of `canActivate` is what
   * makes it trustworthy.
   */
  private readRequestedWorkspace(request: Request): string | undefined {
    const params = request.params as Record<string, string | undefined> | undefined;
    const fromParam = params?.['tenantId'] ?? params?.['workspaceId'];
    if (fromParam) {
      return fromParam.trim();
    }

    const header = request.headers[WORKSPACE_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    return value?.trim() || undefined;
  }

  /**
   * Installs the verified actor for the remainder of the request.
   *
   * Nest runs the handler after `canActivate` returns, which is outside this call stack, so the
   * AsyncLocalStorage context set here would not survive. The verified actor is therefore
   * attached to the request object and re-established by `RequestActorInterceptor`.
   */
  private continueWith(context: ExecutionContext, actor: AuthenticatedActor): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { ubossActor?: AuthenticatedActor }>();
    request.ubossActor = actor;
    return true;
  }
}

/** Property the guard uses to hand the verified actor to the interceptor. */
export const VERIFIED_ACTOR_PROPERTY = 'ubossActor';
