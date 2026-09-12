import { Global, Logger, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { CompositeActorResolver, SessionActorResolver } from '../auth/session-actor.resolver.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  ActorResolver,
  DevHeaderActorResolver,
  isDevHeaderResolverPermitted,
} from '../request-context/actor-resolver.js';
import { RequestActorInterceptor } from './request-actor.interceptor.js';
import { TenantContextService } from './tenant-context.service.js';
import { TenantGuard } from './tenant.guard.js';

/**
 * Tenancy: request context resolution, the tenant guard and the tenant scope service.
 *
 * The guard and interceptor are registered **globally**. Tenancy is not something a route opts
 * into — every route is refused unless it carries an explicit policy decorator, so a new
 * controller cannot be accidentally public.
 */
@Global()
@Module({
  providers: [
    TenantContextService,
    {
      /**
       * The application's actor resolver.
       *
       * Since Prompt 5 this is **session-backed**: `SessionActorResolver` authenticates from the
       * session cookie. That was the single integration point Prompt 4 left open — the guard,
       * request context and RLS wiring are unchanged.
       *
       * The development header resolver is layered *behind* it, so a real session always wins,
       * and it is only constructed when `isDevHeaderResolverPermitted()` allows — which throws
       * rather than returning true if the flag is set with `NODE_ENV=production`.
       */
      provide: ActorResolver,
      inject: [SessionActorResolver, PrismaService],
      useFactory: (sessionResolver: SessionActorResolver, prisma: PrismaService): ActorResolver => {
        if (!isDevHeaderResolverPermitted()) {
          return sessionResolver;
        }

        new Logger('TenancyModule').warn(
          'Layering the development header actor resolver behind session authentication — ' +
            'requests can impersonate any known person. Never enable AUTH_DEV_HEADERS_ENABLED ' +
            'outside development or testing.',
        );

        const devResolver = new DevHeaderActorResolver(async (ubossUniqueId) =>
          prisma.runAsPlatformOperation(async () =>
            prisma.client.user.findUnique({
              where: { ubossUniqueId },
              select: { id: true, ubossUniqueId: true, isPlatformActor: true },
            }),
          ),
        );

        return new CompositeActorResolver(sessionResolver, devResolver);
      },
    },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestActorInterceptor },
  ],
  exports: [TenantContextService, ActorResolver],
})
export class TenancyModule {}
