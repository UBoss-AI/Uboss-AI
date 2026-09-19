import type { INestApplication } from '@nestjs/common';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';

import {
  ALLOW_ANY_PERMISSION_KEY,
  REQUIRE_PERMISSION_KEY,
  REQUIRE_USER_TYPE_KEY,
} from './authorization/authorization.decorators.js';
import {
  ALLOW_ANONYMOUS_KEY,
  PLATFORM_ONLY_KEY,
  TENANT_SCOPED_KEY,
} from './tenancy/tenancy.decorators.js';

/**
 * Put each route's **guards** into the generated OpenAPI document.
 *
 * ## Why this exists at all
 *
 * `@nestjs/swagger` documents what a route *is* — its verb, its path, its parameters. It knows
 * nothing about `@RequirePermission`, because that is this product's own decorator. In an API
 * whose whole shape is *User Type + Role + Scope + Permission*, a reference that omits the
 * permission omits the only thing a reader actually needs: it would list four hundred routes and
 * answer none of the questions anybody has about them.
 *
 * So the metadata the guards read at request time is read again here, from the same keys, and
 * written into each operation's description. There is no second source: if a decorator changes,
 * this changes with it, because it is the decorator that is being read.
 *
 * ## How an operation is matched to its handler
 *
 * Swagger's default `operationId` is `ControllerClass_methodName`, and that is the only stable
 * link between the document and the class it came from. So the controllers are walked once, keyed
 * the same way, and the lookup is by that key. An operation whose id does not match is left
 * untouched rather than guessed at — a wrong permission in a reference is worse than a missing
 * one, because a reader would act on it.
 */
export function annotateGuards(app: INestApplication, document: OpenAPIObject): OpenAPIObject {
  /*
   * `ModulesContainer` rather than `DiscoveryService`: the latter needs `DiscoveryModule` to be
   * imported, and adding a module to `AppModule` so that a *document* can be written would make
   * the running application carry a dependency it has no other use for. The container is part of
   * the core injector and is always there.
   */
  const modules = app.get(ModulesContainer);
  const scanner = new MetadataScanner();

  /** `ControllerClass_method` → the lines describing what that route requires. */
  const notes = new Map<string, string[]>();

  const wrappers = [...modules.values()].flatMap((module) => [...module.controllers.values()]);

  for (const wrapper of wrappers) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    if (instance === undefined || instance === null) continue;

    const controllerClass = wrapper.metatype;
    if (typeof controllerClass !== 'function') continue;

    const prototype = Object.getPrototypeOf(instance) as object;

    // Class-level guards apply to every method on it, so they are read once.
    const classPlatformOnly = Reflect.getMetadata(PLATFORM_ONLY_KEY, controllerClass) === true;
    const classTenantScoped = Reflect.getMetadata(TENANT_SCOPED_KEY, controllerClass) === true;

    for (const method of scanner.getAllMethodNames(prototype)) {
      const handler = (instance as Record<string, unknown>)[method];
      if (typeof handler !== 'function') continue;

      const lines: string[] = [];

      const required = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) as
        | readonly { module: string; action: string }[]
        | undefined;
      const anyOf = Reflect.getMetadata(ALLOW_ANY_PERMISSION_KEY, handler) as
        | readonly { module: string; action: string }[]
        | undefined;
      const userTypes = Reflect.getMetadata(REQUIRE_USER_TYPE_KEY, handler) as
        | readonly string[]
        | undefined;
      const anonymous =
        Reflect.getMetadata(ALLOW_ANONYMOUS_KEY, handler) === true ||
        Reflect.getMetadata(ALLOW_ANONYMOUS_KEY, controllerClass) === true;

      if (required !== undefined && required.length > 0) {
        lines.push(
          `**Requires** \`${required.map((p) => `${p.module}:${p.action}`).join('` and `')}\``,
        );
      }
      if (anyOf !== undefined && anyOf.length > 0) {
        lines.push(`**Requires any of** \`${anyOf.map((p) => `${p.module}:${p.action}`).join('`, `')}\``);
      }
      if (userTypes !== undefined && userTypes.length > 0) {
        lines.push(`**User type** must be ${userTypes.map((t) => `\`${t}\``).join(' or ')}`);
      }

      if (classPlatformOnly || Reflect.getMetadata(PLATFORM_ONLY_KEY, handler) === true) {
        lines.push('**Platform plane** — a company member is refused outright.');
      }
      if (classTenantScoped) {
        lines.push(
          `**Workspace header required** — \`x-uboss-workspace\` must name the same company as the path.`,
        );
      }
      if (anonymous) {
        lines.push('**No session required.**');
      }

      /*
       * A route with no permission decorator is worth saying so about, rather than leaving blank.
       * It is not necessarily open — the tenant guard and the session still apply — but it is not
       * permission-checked, and that distinction is the one a reader most needs drawn for them.
       */
      if (required === undefined && anyOf === undefined && !anonymous) {
        lines.push(
          '_No permission decorator._ Still session- and tenancy-checked; authorization, where ' +
            'it applies, is decided inside the service against the loaded record.',
        );
      }

      if (lines.length > 0) {
        notes.set(`${controllerClass.name}_${method}`, lines);
      }
    }
  }

  let annotated = 0;
  for (const operations of Object.values(document.paths)) {
    for (const operation of Object.values(operations as Record<string, unknown>)) {
      if (typeof operation !== 'object' || operation === null) continue;
      const typed = operation as { operationId?: string; description?: string };
      if (typed.operationId === undefined) continue;

      const lines = notes.get(typed.operationId);
      if (lines === undefined) continue;

      typed.description = [typed.description, lines.join('\n\n')]
        .filter((part) => part !== undefined && part !== '')
        .join('\n\n');
      annotated += 1;
    }
  }

  // Returned on the document itself so a reader can tell whether this ran at all, rather than
  // wondering why one route says nothing.
  document.info.description = `${document.info.description ?? ''}\n\nGuard notes attached to ${annotated} of the operations below, read from the same metadata the guards enforce at request time.`;

  return document;
}
