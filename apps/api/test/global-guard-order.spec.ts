import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APP_GUARD } from '@nestjs/core';

import { AppModule } from '../src/app.module.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { ModuleEntitlementService } from '../src/commercial/module-entitlement.service.js';
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

  /*
   * The plan gate, which is only a gate if the commercial plane is in the graph.
   *
   * `PermissionGuard` refuses a module the company's plan does not include, and it takes
   * `ModuleEntitlementService` **optionally** — required, every test module that builds a Nest
   * application would have to provide the commercial plane for reasons unrelated to what it
   * tests. The cost of that choice is a fail-open: remove `CommercialModule` from the graph and
   * entitlement silently stops being enforced, with every other test still green.
   *
   * This is the test that would not be. It asserts the provider is reachable from `AppModule`,
   * which is the one place the fail-open matters.
   *
   * What it does not assert is the refusal itself — that is behaviour, proven against the
   * running product, where a company on `growth` (no `performance` module) is answered 403 by
   * `GET /tenants/:id/performance/me` and 200 by a module its plan does include.
   */
  it('wires the plan gate into the guard, so entitlement is enforced and not merely optional', () => {
    const provided = modules.some((module) => {
      const providers = (Reflect.getMetadata('providers', module as object) ?? []) as unknown[];
      return providers.includes(ModuleEntitlementService);
    });

    assert.ok(
      provided,
      'ModuleEntitlementService is not provided anywhere in AppModule’s graph. PermissionGuard ' +
        'injects it @Optional, so it will resolve to undefined and every company will reach ' +
        'every module its role grants — including the ones its plan does not include.',
    );
  });
});

/**
 * What an `@Optional()` dependency must still be given in the real graph.
 *
 * `HierarchyService` takes `FileService` optionally, because requiring it put the file store --
 * and its storage adapter and its malware scanner -- into the provider list of every test that
 * builds a module around the hierarchy, including two with nothing to do with files.
 *
 * The risk of that marker is a real misconfiguration nobody notices: the company pictures would
 * simply refuse, in production, with nothing failing earlier. So the marker buys the tests their
 * freedom and this buys it back — `OrganizationModule` must actually import the module that
 * provides the file store, and that is asserted against the real module metadata rather than
 * against a comment.
 */
describe('optional dependencies the real graph still has to supply', () => {
  const importsOf = (moduleName: string): string[] => {
    const module = importedModules(AppModule).find(
      (candidate) => (candidate as { name?: string }).name === moduleName,
    );
    assert.ok(module, `${moduleName} is no longer in the graph`);
    return ((Reflect.getMetadata('imports', module as object) ?? []) as unknown[]).map(
      (entry) => (entry as { name?: string }).name ?? '(unnamed)',
    );
  };

  it('gives the hierarchy its file store, so company pictures are not refused in production', () => {
    const names = importsOf('OrganizationModule');
    assert.ok(
      names.includes('KnowledgeModule'),
      'OrganizationModule must import KnowledgeModule. HierarchyService takes FileService as an ' +
        '@Optional() dependency so that tests need not provide a storage adapter and a malware ' +
        'scanner — which means nothing fails at startup when it is missing. What fails instead ' +
        'is every attempt to store or read a company picture, at the moment somebody tries it. ' +
        `The imports are: ${names.join(', ')}.`,
    );
  });

  /*
   * The import photographs, and why this assertion is not paranoia.
   *
   * `BulkOperationService` takes the file store and the photo service optionally, and when they
   * are absent it treats an import as having sent no photographs. That is the right behaviour for
   * a test module and a silent disaster in production: an administrator pastes fifty faces into a
   * spreadsheet, every person is created, and not one picture arrives. Nothing errors, nothing is
   * logged, and the only symptom is fifty people with initials where their photograph should be.
   */
  it('gives bulk imports the file store and the photo service, so pasted photographs are not dropped', () => {
    const names = importsOf('AccessModule');

    for (const required of ['KnowledgeModule', 'OrganizationModule']) {
      assert.ok(
        names.includes(required),
        `AccessModule must import ${required}. BulkOperationService takes FileService and ` +
          'EmployeePhotoService as @Optional() dependencies, and when they are missing it ' +
          'quietly imports everybody without their photographs — no error, no warning, just ' +
          `people with no picture. The imports are: ${names.join(', ')}.`,
      );
    }
  });
});
