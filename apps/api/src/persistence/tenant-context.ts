/**
 * Tenant scope — the only key that opens a tenant-owned repository method.
 *
 * The type is branded so a bare `string` cannot be passed where a tenant scope is required.
 * That matters because working rule E forbids trusting a browser-supplied tenant id: the only
 * way to obtain a `TenantScope` is through a constructor that documents where the value came
 * from, and `fromVerifiedMembership` is the one intended for request handling.
 *
 * Prompt 4 adds the request-context resolution and the guard that calls it. Prompt 3 defines
 * the shape so repositories can be written against it now.
 */

declare const TENANT_SCOPE_BRAND: unique symbol;

export interface TenantScope {
  readonly tenantId: string;
  readonly [TENANT_SCOPE_BRAND]: true;
}

/**
 * Canonical UUID form. Validated at the point a scope is created because `SET LOCAL` cannot be
 * parameterised: PostgreSQL only accepts a literal there, so the tenant id is interpolated into
 * SQL when the RLS scope is declared (see `PrismaService.runInTenantTransaction`). Guaranteeing
 * the value is a UUID here makes that interpolation provably injection-free, rather than relying
 * on every future caller to have sanitised it.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTenantId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function brand(tenantId: string): TenantScope {
  if (!tenantId) {
    throw new Error('A tenant scope requires a tenant id.');
  }
  if (!isTenantId(tenantId)) {
    throw new Error(
      `Refusing to build a tenant scope from "${tenantId}": a tenant id must be a UUID.`,
    );
  }
  return { tenantId } as TenantScope;
}

/**
 * Build a scope from a membership that the server has already verified for the authenticated
 * actor. This is the correct path for request handling.
 */
export function tenantScopeFromVerifiedMembership(membership: {
  tenantId: string;
  userId: string;
}): TenantScope {
  return brand(membership.tenantId);
}

/**
 * Build a scope for platform-plane work that legitimately acts on one tenant — provisioning,
 * support operations, migrations, seeds and tests.
 *
 * Never call this with a value taken from a request body, query string or header.
 */
export function tenantScopeForPlatformOperation(tenantId: string): TenantScope {
  return brand(tenantId);
}
