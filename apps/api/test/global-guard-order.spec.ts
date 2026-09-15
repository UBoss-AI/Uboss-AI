import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APP_GUARD } from '@nestjs/core';

import { AppModule } from '../src/app.module.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { TenantGuard } from '../src/tenancy/tenant.guard.js';

/**
 * The order of the two global guards, which is load-bearing and was wrong.
 *
 * ## What went wrong
 *
 * `TenantGuard` verifies the session and the membership and attaches the verified actor to the
 * request. `PermissionGuard` reads that actor — it cannot call `getActor()`, because the
 * AsyncLocalStorage scope an interceptor opens does not reach a guard. Both are registered with
 * `APP_GUARD`, and Nest runs global guards in **registration order**, which for global providers
 * is the order their modules appear in the root module's `imports`.
 *
 * `AuthorizationModule` was imported at position 3 and `TenancyModule` at position 24. So
 * `PermissionGuard` ran first, found no actor, and threw `Authentication is required.` — a 403 on
 * **every route carrying `@RequirePermission`**, for every signed-in person, in a browser. The
 * dashboard, reports, to-do, objectives, hierarchy, settings: all of them.
 *
 * ## Why nothing caught it
 *
 * Every e2e suite in this repository builds its own testing module — `controllers: [X]` with a
 * hand-picked provider list — rather than importing `AppModule`. That is fast and focused, and it
 * means the global guard stack, the thing that decides whether any of it is reachable, was never
 * assembled by a test. Two thousand passing assertions, and the product refused every request.
 *
 * ## Why this test looks at metadata rather than sending a request
 *
 * Booting the real `AppModule` needs a database, Redis and the full environment, and a test that
 * heavy tends to be the one people skip. The defect was never subtle behaviour — it was an
 * ordering, visible in the module graph. So this reads the graph, and reads it the way Nest does.
 */

/** The modules Nest will register, depth-first, exactly as it walks `imports`. */
function importedModules(root: unknown, seen = new Set<unknown>()): unknown[] {
  if (seen.has(root)) return [];
  seen.add(root);

  const imports = (Reflect.getMetadata('imports', root as object) ?? []) as unknown[];
  const flat: unknown[] = [];
  for (const imported of imports) {
    // A dynamic module is `{ module, providers, ... }`; a static one is the class itself.
    const candidate =
      imported !== null && typeof imported === 'object' && 'module' in imported
        ? (imported as { module: unknown }).module
        : imported;
    flat.push(candidate, ...importedModules(candidate, seen));
  }
  return flat;
}

/** Position of the module that registers this class as an `APP_GUARD`. */
function guardPosition(modules: unknown[], guard: unknown): number {
  return modules.findIndex((module) => {
    const providers = (Reflect.getMetadata('providers', module as object) ?? []) as unknown[];
    return providers.some(
      (provider) =>
        provider !== null &&
        typeof provider === 'object' &&
        (provider as { provide?: unknown }).provide === APP_GUARD &&
        (provider as { useClass?: unknown }).useClass === guard,
    );
  });
}

describe('global guard registration order', () => {
  const modules = importedModules(AppModule);

  it('registers TenantGuard before PermissionGuard', () => {
    const tenant = guardPosition(modules, TenantGuard);
    const permission = guardPosition(modules, PermissionGuard);

    assert.notEqual(tenant, -1, 'TenantGuard is no longer registered as a global guard');
    assert.notEqual(permission, -1, 'PermissionGuard is no longer registered as a global guard');

    assert.ok(
      tenant < permission,
      `TenantGuard must be registered before PermissionGuard. TenantGuard is at ${tenant} and ` +
        `PermissionGuard at ${permission}, so PermissionGuard runs first, finds no verified ` +
        'actor on the request, and refuses every @RequirePermission route with 403 ' +
        '"Authentication is required." Move TenancyModule earlier in AppModule.imports.',
    );
  });

  it('still registers both of them', () => {
    // A "fix" that deleted one of the guards would satisfy an ordering check on its own.
    assert.notEqual(guardPosition(modules, TenantGuard), -1);
    assert.notEqual(guardPosition(modules, PermissionGuard), -1);
  });
});
