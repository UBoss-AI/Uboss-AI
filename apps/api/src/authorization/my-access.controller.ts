import { Controller, Get, UnauthorizedException } from '@nestjs/common';

import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { AuthorizationService } from './authorization.service.js';

/**
 * What the signed-in person may see — Prompt 40A (CR-03).
 *
 * ## Why this is separate from `AuthorizationController`
 *
 * That controller is `@PlatformOnly`: it answers "what can *this other person* do", which is an
 * administrative question and rightly restricted to the Master Console. This answers "what can
 * **I** do", which every signed-in person is entitled to ask about themselves — and the sidebar
 * cannot render without it.
 *
 * Splitting them was the alternative to loosening the platform gate on a controller that also
 * exposes role administration and the full matrix for arbitrary users. One narrow self-scoped route
 * is a much smaller surface than a relaxed one on a broad controller.
 *
 * ## It grants nothing and hides nothing
 *
 * The response is a description of grants this person already holds. Navigation built from it is
 * **presentation only**: every route is independently guarded, and an item this omits is refused by
 * the same absent grant that omitted it. One mechanism, read twice — which is why there is no
 * separate "should the sidebar show X" rule anywhere.
 */
@Controller('tenants/:tenantId/my-access')
@TenantScoped()
export class MyAccessController {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * No `@RequirePermission`, deliberately.
   *
   * Gating "what am I allowed to do" behind a permission is circular: the person who most needs
   * the answer is the one with the fewest grants, and a standard Employee holding no
   * administrative permission would get an empty sidebar rather than their own.
   *
   * `@TenantScoped` still applies, so a verified membership in this company is required.
   */
  @Get()
  async mine(): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const userId = actorUserId(getActor());
    if (userId === undefined || userId === null) {
      throw new UnauthorizedException('This requires a signed-in member of the company.');
    }

    const context = await this.authorization.contextFor(scope, userId);

    return {
      userId,
      userType: context.userType,
      assignedScope: context.scope.kind,
      visibleModules: context.visibleModules,
      // The grants themselves, so a screen can disable a button rather than offering an action
      // that will be refused. The server still refuses it — this only spares the round trip.
      granted: context.granted,
      note:
        'Navigation built from this is presentation only. Every route is guarded independently, ' +
        'and an item missing here is refused by the same absent grant that removed it.',
    };
  }
}
