import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The authenticated principal, before any workspace has been chosen.
 *
 * Separate from `AuthenticatedActor` on purpose: a signed-in company person is not yet a
 * `TenantActor`, because that requires a membership the server has verified. Keeping the two
 * types distinct means a half-verified tenant actor is unrepresentable.
 */
export type ResolvedPrincipal =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'platform'; readonly userId: string; readonly ubossUniqueId: string }
  | { readonly kind: 'person'; readonly userId: string; readonly ubossUniqueId: string };

export const ANONYMOUS_PRINCIPAL: ResolvedPrincipal = { kind: 'anonymous' };

/**
 * The seam where authentication plugs in.
 *
 * Prompt 4 deliberately ships no real implementation: login, sessions and invitation
 * activation are Prompt 5. The default resolver authenticates **nobody**, so the system is
 * safe by default and every tenant-scoped route is denied until Prompt 5 supplies a real
 * resolver. Nothing is left in a state where a header can assert identity in production.
 */
@Injectable()
export abstract class ActorResolver {
  abstract resolve(request: Request): Promise<ResolvedPrincipal>;
}

/**
 * Production default: nobody is authenticated.
 *
 * This is not a stub that "allows everything pending auth" — that shape has a habit of
 * surviving into production. It denies everything instead, which is the failure that gets
 * noticed.
 */
@Injectable()
export class AnonymousActorResolver extends ActorResolver {
  async resolve(): Promise<ResolvedPrincipal> {
    return ANONYMOUS_PRINCIPAL;
  }
}

/** Header carrying the UBoss Unique ID to act as, for the development resolver only. */
export const DEV_ACTOR_HEADER = 'x-uboss-dev-actor';

export const DEV_HEADERS_ENABLED_ENV = 'AUTH_DEV_HEADERS_ENABLED';

/**
 * Is the development header resolver permitted in this process?
 *
 * Requires the opt-in flag **and** a non-production `NODE_ENV`. If the flag is set in
 * production this throws at startup rather than quietly ignoring it: a deployment that thinks
 * header impersonation is on must fail loudly, not run with a false sense of either state.
 */
export function isDevHeaderResolverPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  const requested = env[DEV_HEADERS_ENABLED_ENV] === 'true';
  if (!requested) {
    return false;
  }

  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      `${DEV_HEADERS_ENABLED_ENV}=true is not permitted when NODE_ENV=production. ` +
        'Header-based actor impersonation is a development and testing aid only.',
    );
  }

  return true;
}

/**
 * Development and testing resolver: treats a header as "this person is signed in".
 *
 * It still does NOT trust the header blindly — the lookup is delegated to a callback that must
 * confirm the person exists. What it skips is proof of *possession* (a password or session),
 * which is exactly what Prompt 5 adds.
 *
 * Never registered unless `isDevHeaderResolverPermitted()` returns true.
 */
export class DevHeaderActorResolver extends ActorResolver {
  private readonly logger = new Logger(DevHeaderActorResolver.name);

  constructor(
    private readonly lookup: (
      ubossUniqueId: string,
    ) => Promise<{ id: string; ubossUniqueId: string; isPlatformActor: boolean } | null>,
  ) {
    super();
    this.logger.warn(
      'Development header actor resolver is ACTIVE. Requests may impersonate any known person ' +
        `via the ${DEV_ACTOR_HEADER} header. This must never be enabled in production.`,
    );
  }

  async resolve(request: Request): Promise<ResolvedPrincipal> {
    const raw = request.headers[DEV_ACTOR_HEADER];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();

    if (!value) {
      return ANONYMOUS_PRINCIPAL;
    }

    const user = await this.lookup(value);
    if (!user) {
      // An unknown id resolves to anonymous rather than an error, so probing the header cannot
      // be used to enumerate which UBoss Unique IDs exist.
      return ANONYMOUS_PRINCIPAL;
    }

    return user.isPlatformActor
      ? { kind: 'platform', userId: user.id, ubossUniqueId: user.ubossUniqueId }
      : { kind: 'person', userId: user.id, ubossUniqueId: user.ubossUniqueId };
  }
}
