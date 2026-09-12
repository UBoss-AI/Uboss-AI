import { Injectable } from '@nestjs/common';

import type { ScimClient, UserGroup, UserGroupMember } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * Repository for external provisioning: `scim_clients`, `user_groups` and `user_group_members`.
 *
 * All three are tenant-owned and under RLS. A SCIM request is authenticated by a bearer token
 * that belongs to exactly one company, so the tenant scope for every call below comes from the
 * *credential*, never from anything in the request path or body — which is why a SCIM client
 * cannot reach another company's users even by guessing ids.
 */
@Injectable()
export class ProvisioningRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- SCIM clients ----

  async createScimClient(
    scope: TenantScope,
    input: { displayName: string; tokenHash: string },
  ): Promise<ScimClient> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.scimClient.create({
        data: {
          tenantId: scope.tenantId,
          displayName: input.displayName,
          tokenHash: input.tokenHash,
        },
      });
    });
  }

  async listScimClients(scope: TenantScope): Promise<ScimClient[]> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.scimClient.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { createdAt: 'desc' },
      });
    });
  }

  async revokeScimClient(scope: TenantScope, clientId: string, at: Date): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.scimClient.updateMany({
        where: { id: clientId, tenantId: scope.tenantId, revokedAt: null },
        // The token hash is kept: it is a hash, it grants nothing, and keeping it means a later
        // "was this the credential that did X" question is answerable.
        data: { enabled: false, revokedAt: at, version: { increment: 1 } },
      });
      return result.count;
    });
  }

  /**
   * Authenticate a SCIM bearer token.
   *
   * Platform-plane and keyed by hash only: this is how a request *acquires* its tenant scope, so
   * it cannot already have one. A caller with no valid token selects no row.
   */
  async findEnabledScimClientByTokenHashForPlatform(
    tokenHash: string,
  ): Promise<(ScimClient & { tenant: { id: string; lifecycleState: string } }) | null> {
    return this.prisma.client.scimClient.findFirst({
      where: { tokenHash, enabled: true, revokedAt: null },
      include: { tenant: { select: { id: true, lifecycleState: true } } },
    });
  }

  /** Best-effort "last used" stamp, so a stale provisioning credential is visible. */
  async touchScimClient(clientId: string, at: Date): Promise<void> {
    await this.prisma.client.scimClient.updateMany({
      where: { id: clientId },
      data: { lastUsedAt: at },
    });
  }

  // ---- Groups ----

  async createGroup(
    scope: TenantScope,
    input: {
      displayName: string;
      externalId?: string | undefined;
      source?: 'Local' | 'Scim';
    },
  ): Promise<UserGroup> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.userGroup.create({
        data: {
          tenantId: scope.tenantId,
          displayName: input.displayName,
          ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
          source: input.source ?? 'Local',
        },
      });
    });
  }

  async findGroup(scope: TenantScope, groupId: string): Promise<UserGroup | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.userGroup.findFirst({
        where: { id: groupId, tenantId: scope.tenantId },
      });
    });
  }

  async findGroupByExternalId(scope: TenantScope, externalId: string): Promise<UserGroup | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.userGroup.findFirst({
        where: { tenantId: scope.tenantId, externalId },
      });
    });
  }

  async findGroupByName(scope: TenantScope, displayName: string): Promise<UserGroup | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.userGroup.findFirst({
        where: { tenantId: scope.tenantId, displayName },
      });
    });
  }

  /** One page of groups. SCIM pagination is 1-based, which the caller translates. */
  async listGroups(
    scope: TenantScope,
    options: { skip?: number; take?: number } = {},
  ): Promise<UserGroup[]> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.userGroup.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { displayName: 'asc' },
        skip: options.skip ?? 0,
        take: Math.min(options.take ?? 100, 500),
      });
    });
  }

  async countGroups(scope: TenantScope): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.userGroup.count({ where: { tenantId: scope.tenantId } });
    });
  }

  async renameGroup(scope: TenantScope, groupId: string, displayName: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.userGroup.updateMany({
        where: { id: groupId, tenantId: scope.tenantId },
        data: { displayName, version: { increment: 1 } },
      });
      return result.count;
    });
  }

  async deleteGroup(scope: TenantScope, groupId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.userGroup.deleteMany({
        where: { id: groupId, tenantId: scope.tenantId },
      });
      return result.count;
    });
  }

  // ---- Group membership ----

  async listGroupMembers(
    scope: TenantScope,
    groupId: string,
  ): Promise<(UserGroupMember & { user: { id: string; displayName: string; email: string } })[]> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.userGroupMember.findMany({
        where: { tenantId: scope.tenantId, groupId },
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  async listGroupsForUser(scope: TenantScope, userId: string): Promise<UserGroup[]> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const rows = await this.prisma.client.userGroupMember.findMany({
        where: { tenantId: scope.tenantId, userId },
        include: { group: true },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => row.group);
    });
  }

  /**
   * Add a person to a group.
   *
   * Idempotent: SCIM clients re-send the full membership list routinely, and a repeated PUT must
   * not be an error. The unique constraint on (group, user) is what makes this safe to retry.
   */
  async addGroupMember(
    scope: TenantScope,
    input: { groupId: string; userId: string; source?: 'Local' | 'Scim' },
  ): Promise<UserGroupMember> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.userGroupMember.upsert({
        where: { groupId_userId: { groupId: input.groupId, userId: input.userId } },
        create: {
          tenantId: scope.tenantId,
          groupId: input.groupId,
          userId: input.userId,
          source: input.source ?? 'Local',
        },
        update: {},
      }),
    );
  }

  async removeGroupMember(scope: TenantScope, groupId: string, userId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.userGroupMember.deleteMany({
        where: { tenantId: scope.tenantId, groupId, userId },
      });
      return result.count;
    });
  }

  /** Replace a group's whole membership — the shape a SCIM `PUT /Groups/:id` implies. */
  async replaceGroupMembers(scope: TenantScope, groupId: string, userIds: string[]): Promise<void> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      await this.prisma.client.userGroupMember.deleteMany({
        where: { tenantId: scope.tenantId, groupId },
      });

      if (userIds.length > 0) {
        await this.prisma.client.userGroupMember.createMany({
          data: userIds.map((userId) => ({
            tenantId: scope.tenantId,
            groupId,
            userId,
            source: 'Scim' as const,
          })),
          skipDuplicates: true,
        });
      }
    });
  }
}
