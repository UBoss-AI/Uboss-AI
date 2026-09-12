import { Injectable } from '@nestjs/common';
import type { Tenant } from '../generated/prisma/client.js';
import type { TenantLifecycleState } from '../generated/prisma/enums.js';

import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * Repository for `tenants`.
 *
 * `tenants` is the tenant *root*, not a tenant-owned child table, so its rows are keyed by the
 * tenant id itself. Reads still go through a `TenantScope` so a caller cannot read an arbitrary
 * company by guessing its id; only creation and slug lookup are platform-plane operations,
 * which is correct because provisioning happens in the Master Console and there is no public
 * company signup.
 */
@Injectable()
export class TenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Platform-plane provisioning. Never reachable from a company workspace request. */
  async createForPlatform(input: {
    slug: string;
    name: string;
    legalName?: string;
  }): Promise<Tenant> {
    return this.prisma.client.tenant.create({
      data: {
        slug: input.slug,
        name: input.name,
        ...(input.legalName === undefined ? {} : { legalName: input.legalName }),
      },
    });
  }

  /** Read the tenant the caller is scoped to. */
  async findInScope(scope: TenantScope): Promise<Tenant | null> {
    return this.prisma.client.tenant.findUnique({ where: { id: scope.tenantId } });
  }

  /** Platform-plane lookup, used during provisioning and sign-in routing. */
  /** Platform-plane lookup by id. Used by the provisioning replay path. */
  async findByIdForPlatform(tenantId: string): Promise<Tenant | null> {
    return this.prisma.client.tenant.findUnique({ where: { id: tenantId } });
  }

  async findBySlugForPlatform(slug: string): Promise<Tenant | null> {
    return this.prisma.client.tenant.findUnique({ where: { slug } });
  }

  /**
   * Rename the tenant the caller is scoped to, guarded by the expected row version. Returns 0
   * when the version has moved on, so a concurrent edit is never silently clobbered.
   */
  async rename(scope: TenantScope, name: string, expectedVersion: number): Promise<number> {
    const result = await this.prisma.client.tenant.updateMany({
      where: { id: scope.tenantId, version: expectedVersion },
      data: { name, version: { increment: 1 } },
    });
    return result.count;
  }

  async countForPlatform(): Promise<number> {
    return this.prisma.client.tenant.count();
  }

  /**
   * Move a company through its lifecycle. A platform-plane operation: only the UBoss Master
   * Console changes a company's state, never the company itself.
   *
   * Version-guarded, so two concurrent Master Console operators cannot both think they set the
   * state. Returns 0 when the version has moved on.
   */
  async setLifecycleStateForPlatform(
    tenantId: string,
    lifecycleState: TenantLifecycleState,
    expectedVersion: number,
  ): Promise<number> {
    const result = await this.prisma.client.tenant.updateMany({
      where: { id: tenantId, version: expectedVersion },
      data: { lifecycleState, version: { increment: 1 } },
    });
    return result.count;
  }
}
