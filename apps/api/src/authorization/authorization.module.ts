import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthorizationController } from './authorization.controller.js';
import { MyAccessController } from './my-access.controller.js';
import { AuthorizationService } from './authorization.service.js';
import { PermissionGuard } from './permission.guard.js';
import { RoleAdministrationService } from './role-administration.service.js';
import { TcsionMappingService } from './tcsion-mapping.service.js';

/**
 * The authorization engine.
 *
 * Global because `AuthorizationService` is the thing every future feature module will inject to
 * ask "may this person do this to this row", and threading it through imports would mean every
 * module declaring a dependency on authorization — which is true of all of them.
 *
 * ## `PermissionGuard` is registered globally, and that is safe
 *
 * A global guard normally raises the question "what happens to routes that do not know about it".
 * Here: nothing. The guard returns `true` when a route carries no `@RequirePermission`,
 * `@RequireAnyPermission` or `@RequireUserType`, so it cannot break an existing route — and it
 * cannot *open* one either, because `TenantGuard` still denies anything with no tenancy policy.
 *
 * Registering it globally rather than per-controller is deliberate: a permission decorator that
 * silently did nothing because someone forgot `@UseGuards` would be the worst possible failure —
 * a route that looks protected and is not. Global registration means the decorator is the whole
 * declaration.
 *
 * `HIERARCHY_RESOLVER` is deliberately **not** provided. `TeamSubtree` scope therefore fails
 * closed with a distinct `scope-unevaluable` reason until Prompt 12 registers one. Providing a
 * stub that answered "yes" would silently make every manager's scope the whole company.
 */
@Global()
@Module({
  // MyAccessController is separate from AuthorizationController because that one is
  // `@PlatformOnly` — "what can this other person do" is administrative, "what can I do" is not.
  controllers: [AuthorizationController, MyAccessController],
  providers: [
    AuthorizationService,
    RoleAdministrationService,
    TcsionMappingService,
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AuthorizationService, RoleAdministrationService, TcsionMappingService],
})
export class AuthorizationModule {}
