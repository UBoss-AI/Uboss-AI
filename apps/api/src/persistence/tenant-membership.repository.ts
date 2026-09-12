import { Injectable } from '@nestjs/common';
import type { TenantMembership } from '../generated/prisma/client.js';

import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * Repository for `tenant_memberships` — a tenant-owned table.
 *
 * ## Tenant isolation convention
 *
 * Every method takes a `TenantScope` as its first parameter and merges `tenantId` into the
 * `where` clause. There is deliberately no method that accepts only a record id: reading or
 * writing a membership by id alone would let a caller in Tenant A touch Tenant B's row by
 * guessing a UUID.
 *
 * Reads that miss return `null` rather than throwing, so a cross-tenant guess is
 * indistinguishable from a genuinely absent record and leaks nothing. Writes that miss report
 * `0` affected rows for the same reason.
 */
@Injectable()
export class TenantMembershipRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(scope: TenantScope, input: { userId: string }): Promise<TenantMembership> {
    return this.prisma.client.tenantMembership.create({
      data: { tenantId: scope.tenantId, userId: input.userId },
    });
  }

  /** Find one membership within the scope. Returns null when it belongs to another tenant. */
  async findById(scope: TenantScope, membershipId: string): Promise<TenantMembership | null> {
    return this.prisma.client.tenantMembership.findFirst({
      where: { id: membershipId, tenantId: scope.tenantId },
    });
  }

  async findByUserId(scope: TenantScope, userId: string): Promise<TenantMembership | null> {
    return this.prisma.client.tenantMembership.findFirst({
      where: { userId, tenantId: scope.tenantId },
    });
  }

  async listForTenant(scope: TenantScope): Promise<TenantMembership[]> {
    return this.prisma.client.tenantMembership.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async countForTenant(scope: TenantScope): Promise<number> {
    return this.prisma.client.tenantMembership.count({
      where: { tenantId: scope.tenantId },
    });
  }

  /**
   * Delete one membership within the scope.
   *
   * `deleteMany` is used rather than `delete` on purpose: `delete` needs a unique selector and
   * would throw when the row exists but belongs to another tenant, which both leaks its
   * existence and turns a scoping bug into a 500. This reports 0 instead.
   */
  async deleteById(scope: TenantScope, membershipId: string): Promise<number> {
    const result = await this.prisma.client.tenantMembership.deleteMany({
      where: { id: membershipId, tenantId: scope.tenantId },
    });
    return result.count;
  }

  /**
   * Optimistic-concurrency touch, demonstrating the `row_version` convention: the update only
   * applies when the caller's expected version still matches, so a concurrent writer cannot be
   * silently overwritten. Returns 0 on either a version mismatch or a cross-tenant miss.
   */
  async touch(scope: TenantScope, membershipId: string, expectedVersion: number): Promise<number> {
    const result = await this.prisma.client.tenantMembership.updateMany({
      where: { id: membershipId, tenantId: scope.tenantId, version: expectedVersion },
      data: { version: { increment: 1 } },
    });
    return result.count;
  }

  /**
   * Cross-tenant read used for workspace switching: "which companies does this person belong
   * to". Keyed by the platform user, so it is intentionally not tenant-scoped — and it returns
   * only the caller's own memberships, never another person's.
   */
  /**
   * A membership together with the person it belongs to.
   *
   * Added for SCIM, which has to render a `User` resource from both — and must not be able to
   * read a person who is not a member of the credential's company, which is why the join goes
   * through the scoped membership rather than through `users` directly.
   */
  async findByUserIdWithUser(scope: TenantScope, userId: string) {
    return this.prisma.client.tenantMembership.findFirst({
      where: { userId, tenantId: scope.tenantId },
      include: {
        user: {
          select: { id: true, email: true, displayName: true, ubossUniqueId: true },
        },
      },
    });
  }

  /** SCIM addresses users by the identity provider's own id. Scoped, so ids cannot collide. */
  async findByScimExternalId(scope: TenantScope, externalId: string) {
    return this.prisma.client.tenantMembership.findFirst({
      where: { tenantId: scope.tenantId, scimExternalId: externalId },
      include: {
        user: {
          select: { id: true, email: true, displayName: true, ubossUniqueId: true },
        },
      },
    });
  }

  /** One page of memberships with their people, for a SCIM list. */
  async listForTenantWithUsers(scope: TenantScope, options: { skip?: number; take?: number } = {}) {
    return this.prisma.client.tenantMembership.findMany({
      where: { tenantId: scope.tenantId },
      include: {
        user: {
          select: { id: true, email: true, displayName: true, ubossUniqueId: true },
        },
      },
      orderBy: { createdAt: 'asc' },
      skip: options.skip ?? 0,
      take: Math.min(options.take ?? 100, 500),
    });
  }

  /**
   * Change a person's state inside this company.
   *
   * This is how SCIM deprovisions: `active: false` becomes `Suspended`, which keeps the
   * membership and its history while removing access. It is deliberately not a delete — an
   * identity provider that briefly loses sight of someone would otherwise destroy their record.
   */
  async setAccountState(
    scope: TenantScope,
    userId: string,
    state: 'NotInvited' | 'InvitePending' | 'Active' | 'Suspended' | 'Offboarded',
  ): Promise<number> {
    const result = await this.prisma.client.tenantMembership.updateMany({
      where: { tenantId: scope.tenantId, userId },
      data: { accountState: state, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Record that this membership is externally provisioned, and by which external id. */
  async setProvisioningIdentity(
    scope: TenantScope,
    userId: string,
    input: { externalId?: string | undefined; source: 'Local' | 'Scim' },
  ): Promise<number> {
    const result = await this.prisma.client.tenantMembership.updateMany({
      where: { tenantId: scope.tenantId, userId },
      data: {
        ...(input.externalId === undefined ? {} : { scimExternalId: input.externalId }),
        provisioningSource: input.source,
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  async listTenantIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.client.tenantMembership.findMany({
      where: { userId },
      select: { tenantId: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.tenantId);
  }
}
