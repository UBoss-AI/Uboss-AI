import { Injectable, Logger } from '@nestjs/common';
import type { Tenant, TenantMembership, User } from '../generated/prisma/client.js';

import { AuditEventService } from '../audit/audit-event.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantMembershipRepository } from '../persistence/tenant-membership.repository.js';
import { TenantRepository } from '../persistence/tenant.repository.js';
import { generateUbossUniqueId } from '../persistence/uboss-unique-id.js';
import { UserRepository } from '../persistence/user.repository.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';

export interface ProvisionTenantInput {
  slug: string;
  name: string;
  legalName?: string;
  /** The first administrator of the new company. */
  firstMember: { email: string; displayName: string };
  /** Platform actor performing the provisioning, for the audit trail. */
  actorUserId?: string;
}

export interface ProvisionTenantResult {
  tenant: Tenant;
  user: User;
  membership: TenantMembership;
}

/**
 * Provisions a customer company.
 *
 * This is the reference implementation of the service transaction convention: four writes
 * across three tables plus two audit rows, all inside one `runAsPlatformOperation` transaction
 * (which both opens the transaction and declares the RLS scope). If any step
 * fails — a duplicate slug, a UBoss Unique ID collision — nothing is left behind, including the
 * audit rows, so the trail never claims something happened that did not.
 *
 * Provisioning is a **platform-plane** operation: there is no public company signup, so this is
 * only reachable from the UBoss Master Console. The HTTP surface and its permission checks
 * arrive with the Master Console prompts; this is the domain operation.
 */
@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly memberships: TenantMembershipRepository,
    private readonly auditEvents: AuditEventService,
  ) {}

  async provision(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
    return this.prisma.runAsPlatformOperation(async () => {
      const tenant = await this.tenants.createForPlatform({
        slug: input.slug,
        name: input.name,
        ...(input.legalName === undefined ? {} : { legalName: input.legalName }),
      });

      // Reuse the person if they already exist on the platform: one permanent UBoss Unique ID
      // follows them across companies rather than a second identity being created.
      const existing = await this.users.findByEmailForPlatform(input.firstMember.email);
      const user =
        existing ??
        (await this.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email: input.firstMember.email,
          displayName: input.firstMember.displayName,
        }));

      const scope = tenantScopeForPlatformOperation(tenant.id);
      const membership = await this.memberships.create(scope, { userId: user.id });

      await this.auditEvents.appendWithinCurrentScope(null, {
        action: 'tenant.provisioned',
        resourceType: 'tenant',
        resourceId: tenant.id,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
        summary: `Provisioned company ${tenant.name} (${tenant.slug}).`,
        metadata: { slug: tenant.slug, reusedExistingPerson: existing !== null },
      });

      await this.auditEvents.appendWithinCurrentScope(tenant.id, {
        action: 'tenant_membership.created',
        resourceType: 'tenant_membership',
        resourceId: membership.id,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
        summary: `${user.displayName} became the first member of ${tenant.name}.`,
        reason: 'The first member is created by provisioning, which has no existing grantor.',
      });

      this.logger.log(`Provisioned tenant ${tenant.slug} with first member ${user.ubossUniqueId}`);

      return { tenant, user, membership };
    });
  }

  /**
   * Adds an existing platform person to a company, or creates their permanent identity first.
   * Membership plus its audit row commit together.
   */
  async addMember(
    tenantId: string,
    member: { email: string; displayName: string },
    actorUserId?: string,
  ): Promise<{ user: User; membership: TenantMembership }> {
    return this.prisma.runAsPlatformOperation(async () => {
      const scope = tenantScopeForPlatformOperation(tenantId);

      const existing = await this.users.findByEmailForPlatform(member.email);
      const user =
        existing ??
        (await this.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email: member.email,
          displayName: member.displayName,
        }));

      const membership = await this.memberships.create(scope, { userId: user.id });

      await this.auditEvents.appendWithinCurrentScope(tenantId, {
        action: 'tenant_membership.created',
        resourceType: 'tenant_membership',
        resourceId: membership.id,
        ...(actorUserId === undefined ? {} : { actorUserId }),
        summary: `${user.displayName} was added to the company.`,
      });

      return { user, membership };
    });
  }
}
