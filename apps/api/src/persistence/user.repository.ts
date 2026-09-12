import { Injectable } from '@nestjs/common';
import type { User } from '../generated/prisma/client.js';

import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * Repository for `users` — the permanent platform person identity.
 *
 * `users` is deliberately NOT tenant-owned: one person can belong to several companies and
 * keeps one permanent UBoss Unique ID across all of them. Tenant isolation is therefore applied
 * at the membership join, not by putting `tenant_id` on the person.
 *
 * The consequence for callers: a company workspace must reach people through
 * `findInTenant`/`listInTenant`, which require a verified membership. `findByEmailForPlatform`
 * and `findByUbossUniqueIdForPlatform` are platform-plane only. Authorized cross-company
 * profile search uses the UBoss Unique ID, never Aadhaar — and returns only a permitted
 * professional summary, which is built in its own later prompt.
 */
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createForPlatform(input: {
    ubossUniqueId: string;
    email: string;
    displayName: string;
    isPlatformActor?: boolean;
  }): Promise<User> {
    return this.prisma.client.user.create({
      data: {
        ubossUniqueId: input.ubossUniqueId,
        email: input.email,
        displayName: input.displayName,
        isPlatformActor: input.isPlatformActor ?? false,
      },
    });
  }

  /**
   * Read a person **only if** they hold a membership in the caller's tenant. This is the method
   * a company workspace uses; it cannot return someone from another company.
   */
  async findInTenant(scope: TenantScope, userId: string): Promise<User | null> {
    return this.prisma.client.user.findFirst({
      where: {
        id: userId,
        memberships: { some: { tenantId: scope.tenantId } },
      },
    });
  }

  /** Everyone with a membership in the caller's tenant. */
  async listInTenant(scope: TenantScope): Promise<User[]> {
    return this.prisma.client.user.findMany({
      where: { memberships: { some: { tenantId: scope.tenantId } } },
      orderBy: { displayName: 'asc' },
    });
  }

  /** Platform-plane lookup by login handle. Email is a handle, not the identity. */
  async findByEmailForPlatform(email: string): Promise<User | null> {
    return this.prisma.client.user.findUnique({ where: { email } });
  }

  /** Platform-plane lookup by the permanent UBoss Unique ID. */
  async findByUbossUniqueIdForPlatform(ubossUniqueId: string): Promise<User | null> {
    return this.prisma.client.user.findUnique({ where: { ubossUniqueId } });
  }

  /** Platform-plane lookup by internal id, which is what a role assignment row carries. */
  async findByIdForPlatform(userId: string): Promise<User | null> {
    return this.prisma.client.user.findUnique({ where: { id: userId } });
  }

  /**
   * Every platform actor, for the Master Console's access review.
   *
   * Deliberately narrow in what it selects: this list is rendered on a screen, and a full `User`
   * would put an email address and account state on it for no reason. The access review needs to
   * know *who*, not everything about them.
   */
  async listPlatformActorsForPlatform(): Promise<
    { id: string; ubossUniqueId: string; email: string; displayName: string }[]
  > {
    return this.prisma.client.user.findMany({
      where: { isPlatformActor: true },
      select: { id: true, ubossUniqueId: true, email: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });
  }

  async countForPlatform(): Promise<number> {
    return this.prisma.client.user.count();
  }
}
