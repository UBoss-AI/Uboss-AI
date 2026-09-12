/**
 * Who is making a request.
 *
 * Modelled as a discriminated union so every call site must handle all three cases. The two
 * planes are deliberately separate types rather than one shape with optional fields, because
 * "a platform actor with a tenantId" and "a tenant actor without one" must both be
 * unrepresentable.
 */

/** Nobody is authenticated. The default until login exists (Prompt 5). */
export interface AnonymousActor {
  readonly kind: 'anonymous';
}

/**
 * An actor on the platform control plane — the UBoss Master Console. Belongs to no single
 * company, and must never be given a tenant scope by default.
 */
export interface PlatformActor {
  readonly kind: 'platform';
  readonly userId: string;
  readonly ubossUniqueId: string;
}

/**
 * An actor acting inside one company, via a membership the server has verified.
 *
 * `membershipId` is present because the membership row is the authorization fact — carrying it
 * means the scope is traceable to a specific verified record, not to a value someone typed.
 */
export interface TenantActor {
  readonly kind: 'tenant';
  readonly userId: string;
  readonly ubossUniqueId: string;
  readonly tenantId: string;
  readonly membershipId: string;
}

export type AuthenticatedActor = AnonymousActor | PlatformActor | TenantActor | UserActor;

export const ANONYMOUS_ACTOR: AnonymousActor = { kind: 'anonymous' };

export function isPlatformActor(actor: AuthenticatedActor): actor is PlatformActor {
  return actor.kind === 'platform';
}

export function isTenantActor(actor: AuthenticatedActor): actor is TenantActor {
  return actor.kind === 'tenant';
}

/** Short, log-safe description of an actor. Never includes an email. */
export function describeActor(actor: AuthenticatedActor): string {
  switch (actor.kind) {
    case 'anonymous':
      return 'anonymous';
    case 'platform':
      return `platform:${actor.ubossUniqueId}`;
    case 'tenant':
      return `tenant:${actor.tenantId}/${actor.ubossUniqueId}`;
    case 'user':
      return `user:${actor.ubossUniqueId}`;
  }
}

/**
 * An authenticated person who has **not** selected a company workspace.
 *
 * Added at Prompt 5. It is a distinct kind because it is a real, reachable state: someone signs
 * in before choosing a workspace, and person-level screens — Active Sessions, Logout All
 * Devices, the workspace picker — must work there. Modelling it as "a TenantActor with an empty
 * tenantId" would have made every tenant-scoped consumer responsible for noticing the emptiness.
 */
export interface UserActor {
  readonly kind: 'user';
  readonly userId: string;
  readonly ubossUniqueId: string;
}

export function isUserActor(actor: AuthenticatedActor): actor is UserActor {
  return actor.kind === 'user';
}

/** Any authenticated actor, whatever plane or workspace state. */
export function isAuthenticated(
  actor: AuthenticatedActor,
): actor is PlatformActor | TenantActor | UserActor {
  return actor.kind !== 'anonymous';
}

/**
 * The user id of any authenticated actor, or undefined when anonymous.
 * Every authenticated kind carries one, so this is total rather than a cast.
 */
export function actorUserId(actor: AuthenticatedActor): string | undefined {
  return actor.kind === 'anonymous' ? undefined : actor.userId;
}
