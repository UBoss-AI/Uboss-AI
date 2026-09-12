import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../persistence/prisma.service.js';
import {
  tenantScopeFromVerifiedMembership,
  type TenantScope,
} from '../persistence/tenant-context.js';
import { getActor, getCorrelationId } from '../request-context/request-context.js';
import { isTenantActor } from '../request-context/authenticated-actor.js';
import {
  accountCapability,
  lifecycleCapability,
  type TenantLifecycleState,
} from './tenant-lifecycle.js';
import type { AccountState } from '../generated/prisma/enums.js';

export interface VerifiedMembership {
  userId: string;
  tenantId: string;
  membershipId: string;
  /// State of the company itself.
  lifecycleState: TenantLifecycleState;
  /// State of this person inside that company. Both are enforced; they are different concepts.
  accountState: AccountState;
}

/**
 * Resolves the tenant scope for the current request, and is the only sanctioned way for a
 * domain service to obtain one.
 *
 * Working rule E: a tenant-owned operation derives its tenant from **authenticated membership**,
 * never from a browser-supplied `tenant_id`. A request may *ask* for a workspace — a person who
 * belongs to two companies has to be able to choose — but the requested id is only ever used to
 * look up a membership. If no membership exists, the request is refused; the requested value is
 * never trusted on its own.
 */
@Injectable()
export class TenantContextService {
  private readonly logger = new Logger(TenantContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The scope for the current request.
   *
   * Throws rather than returning null: a domain service that reached this point without a
   * verified tenant actor has a wiring bug, and returning an empty scope would turn that bug
   * into a silent cross-tenant query.
   */
  requireScope(): TenantScope {
    const actor = getActor();

    if (!isTenantActor(actor)) {
      throw new ForbiddenException(
        'This operation requires an authenticated company workspace membership.',
      );
    }

    return tenantScopeFromVerifiedMembership({
      tenantId: actor.tenantId,
      userId: actor.userId,
    });
  }

  /** The scope for the current request, or `undefined` for a platform or anonymous actor. */
  optionalScope(): TenantScope | undefined {
    const actor = getActor();
    return isTenantActor(actor)
      ? tenantScopeFromVerifiedMembership({ tenantId: actor.tenantId, userId: actor.userId })
      : undefined;
  }

  /**
   * Verify that `userId` holds a membership in `requestedTenantId`, and report the company's
   * lifecycle state alongside it.
   *
   * This is the single place a requested workspace becomes a trusted scope. The lookup runs as
   * a platform operation because it must read across tenants to answer "does this membership
   * exist" — which is precisely why its result, not its input, is what gets trusted.
   */
  async verifyMembership(
    userId: string,
    requestedTenantId: string,
  ): Promise<VerifiedMembership | null> {
    return this.prisma.runAsPlatformOperation(async () => {
      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { userId, tenantId: requestedTenantId },
        select: {
          id: true,
          tenantId: true,
          userId: true,
          accountState: true,
          tenant: { select: { lifecycleState: true } },
        },
      });

      if (!membership) {
        // Logged at debug, not warn: a person switching workspaces can legitimately request one
        // they have since been removed from, and this must not look like an attack in the logs.
        this.logger.debug(
          `No membership for user ${userId} in tenant ${requestedTenantId} ` +
            `(correlation ${getCorrelationId() ?? 'none'})`,
        );
        return null;
      }

      return {
        userId: membership.userId,
        tenantId: membership.tenantId,
        membershipId: membership.id,
        lifecycleState: membership.tenant.lifecycleState,
        accountState: membership.accountState,
      };
    });
  }

  /** Companies this person may open, for workspace switching. */
  /**
   * The signed-in person's own identity fields.
   *
   * Person-level and keyed by a user id that always comes from a verified session, never from
   * request input — which is why it does not take a tenant scope. Returns only what the person's
   * own screens need; it is not a directory lookup and cannot be used to read anyone else.
   */
  async describeUser(
    userId: string,
  ): Promise<{ email: string; displayName: string; ubossUniqueId: string }> {
    return this.prisma.runAsPlatformOperation(async () => {
      const user = await this.prisma.client.user.findFirst({
        where: { id: userId },
        select: { email: true, displayName: true, ubossUniqueId: true },
      });

      if (!user) {
        // Only reachable if the account was deleted between authenticating and this call.
        throw new UnauthorizedException('That account no longer exists.');
      }

      return user;
    });
  }

  async listMemberships(
    userId: string,
  ): Promise<{ tenantId: string; tenantName: string; lifecycleState: TenantLifecycleState }[]> {
    return this.prisma.runAsPlatformOperation(async () => {
      const rows = await this.prisma.client.tenantMembership.findMany({
        where: { userId },
        select: {
          tenantId: true,
          accountState: true,
          tenant: { select: { name: true, lifecycleState: true } },
        },
        orderBy: { createdAt: 'asc' },
      });

      return rows
        .filter(
          (row) =>
            lifecycleCapability(row.tenant.lifecycleState).canAccess &&
            accountCapability(row.accountState).canAccess,
        )
        .map((row) => ({
          tenantId: row.tenantId,
          tenantName: row.tenant.name,
          lifecycleState: row.tenant.lifecycleState,
        }));
    });
  }

  /**
   * Run `work` inside the current request's tenant scope, with Row-Level Security declared to
   * PostgreSQL as the second layer. This is what a tenant domain service should use.
   */
  async runInScope<T>(work: () => Promise<T>): Promise<T> {
    return this.prisma.runInTenantTransaction(this.requireScope(), work);
  }
}
