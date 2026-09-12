import { SetMetadata } from '@nestjs/common';

import type { Action, ModuleKey, UserType } from '@uboss/types';

/**
 * Route-level authorization decorators.
 *
 * These are **phase 1** of the two-phase check described on `AuthorizationService`: they answer
 * "could this person's roles and this company's policy ever permit this", which is everything a
 * guard can know before the handler has loaded a row. The row-level check — scope and separation
 * of duties — is `assertCanOnResource` inside the handler.
 *
 * They compose with the Prompt 4 tenancy decorators rather than replacing them:
 * `@TenantScoped()` establishes *which company and whether the person may be here at all*, and
 * `@RequirePermission()` then asks *what they may do*. A route with only the second and not the
 * first is refused by `TenantGuard`, which denies anything with no tenancy policy — so the
 * ordering cannot be got wrong by omission.
 */

export const REQUIRE_PERMISSION_KEY = 'uboss:require-permission';
export const REQUIRE_USER_TYPE_KEY = 'uboss:require-user-type';
export const ALLOW_ANY_PERMISSION_KEY = 'uboss:allow-any-permission';

export interface RequiredPermission {
  module: ModuleKey;
  action: Action;
}

/**
 * The route needs this action on this module.
 *
 * Several are permitted and are treated as **all** required, not any — a route that genuinely
 * needs either should say so with `@RequireAnyPermission`, because "any" is the weaker claim and
 * ought to be the one you have to ask for by name.
 */
export const RequirePermission = (
  ...permissions: readonly RequiredPermission[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_PERMISSION_KEY, permissions);

/**
 * The route needs at least one of these.
 *
 * Deliberately a separate decorator rather than an option on the first: a reader skimming a
 * controller should be able to see which routes accept the weaker condition without reading an
 * options object.
 */
export const RequireAnyPermission = (
  ...permissions: readonly RequiredPermission[]
): MethodDecorator & ClassDecorator => SetMetadata(ALLOW_ANY_PERMISSION_KEY, permissions);

/**
 * The route is only for certain user types.
 *
 * Distinct from a permission: some routes are wrong for an External Guest whatever their role
 * says, and expressing that as a permission would mean inventing an action for it. Applied *in
 * addition* to the user-type ceilings in the engine, which no role can lift.
 */
export const RequireUserType = (
  ...userTypes: readonly UserType[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_USER_TYPE_KEY, userTypes);
