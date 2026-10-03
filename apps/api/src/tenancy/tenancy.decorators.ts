import { SetMetadata } from '@nestjs/common';

export const TENANT_SCOPED_KEY = 'uboss:tenant-scoped';
export const PLATFORM_ONLY_KEY = 'uboss:platform-only';
export const ALLOW_ANONYMOUS_KEY = 'uboss:allow-anonymous';

/**
 * Marks a route as requiring a verified company-workspace membership.
 *
 * The guard resolves the workspace, checks the membership against the database and enforces the
 * company's lifecycle state before the handler runs.
 */
export const TenantScoped = (): MethodDecorator & ClassDecorator =>
  SetMetadata(TENANT_SCOPED_KEY, true);

/** Marks a route as reachable only by a platform-plane actor (the UBoss Master Console). */
export const PlatformOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_ONLY_KEY, true);

/**
 * Marks a route as deliberately public, e.g. `GET /health`.
 *
 * Required explicitly rather than being the default: the guard denies anything not marked, so a
 * new route is private until someone consciously opens it. A forgotten decorator produces a
 * 403, which gets noticed, instead of an accidentally public endpoint, which does not.
 */
export const AllowAnonymous = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_ANONYMOUS_KEY, true);

export const AUTHENTICATED_KEY = 'uboss:authenticated';

/**
 * Marks a route as requiring a signed-in person, but **no** company workspace.
 *
 * Added at Prompt 5 because `@AllowAnonymous` deliberately skips actor resolution entirely —
 * which keeps `GET /health` cheap for load-balancer probes, but means a public route cannot see
 * its own caller. Person-level screens (Active Sessions, Logout All Devices, the workspace
 * picker) need identity without a workspace, and that is exactly this policy.
 */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_KEY, true);

export const ALLOWED_WHEN_READ_ONLY_KEY = 'uboss:allowed-when-read-only';

/**
 * Marks a write route as still reachable while the **company** is read-only.
 *
 * ## Why this exists
 *
 * A company that stops paying is put into `ReadOnly`, which refuses every non-GET request. That
 * is the point of it — but paying is a `POST`, so without this the product would lock a customer
 * out of the one screen that gets them back. A door that can only be opened from the inside is
 * not a lock, it is a trap.
 *
 * ## How narrow it is
 *
 * It waives exactly one check and nothing else:
 *
 *   * **Only** the company-level read-only write block. `Suspended`, `Closed`, `Provisioning`
 *     and `PendingActivation` all refuse *access*, not just writes, and are unaffected — a
 *     suspended company still cannot reach this route at all.
 *   * The person's own account state is still enforced. A suspended employee cannot pay.
 *   * `@RequirePermission` still applies. Paying needs `settings:Administer`, as it always did.
 *   * The route must still be `@TenantScoped`, so membership is still proved in the database.
 *
 * It belongs on the routes that take a payment, and on nothing else. A route that changes the
 * company's own data does not get it, however convenient: the whole value of read-only is that
 * the data stops moving.
 */
export const AllowedWhenReadOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOWED_WHEN_READ_ONLY_KEY, true);
