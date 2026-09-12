import { Injectable } from '@nestjs/common';

import type {
  CustomRole,
  PolicyRule,
  RoleAssignment,
  SeparationOfDutiesPolicy,
  TcsionMapping,
} from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * Repository for the authorization tables.
 *
 * Follows the ADR-037 convention: a method that takes a `TenantScope` **declares** that scope to
 * PostgreSQL, so Row-Level Security enforces it alongside the `where` clause. That matters more
 * here than anywhere so far — a `role_assignments` row *is* someone's authority, and a query
 * that forgot `WHERE tenant_id` would let one company read, or write, another's permission grants.
 *
 * Two methods are explicitly platform-plane and named to say so:
 *
 *   * `listPlatformPolicyRulesForPlatform` and `listPlatformSodPoliciesForPlatform` read the
 *     rules whose `tenant_id` is NULL — the Platform layer, which by definition belongs to no
 *     company. They return restrictions only, so a caller learns nothing about other tenants.
 */
@Injectable()
export class AuthorizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Custom roles ----

  async createCustomRole(
    scope: TenantScope,
    input: {
      displayName: string;
      description?: string | undefined;
      permissions: Record<string, string[]>;
      maxScope: string;
      createdByUserId?: string | undefined;
    },
  ): Promise<CustomRole> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.customRole.create({
        data: {
          tenantId: scope.tenantId,
          displayName: input.displayName,
          ...(input.description === undefined ? {} : { description: input.description }),
          permissions: input.permissions,
          maxScope: input.maxScope as never,
          ...(input.createdByUserId === undefined
            ? {}
            : { createdByUserId: input.createdByUserId }),
        },
      }),
    );
  }

  async findCustomRole(scope: TenantScope, roleId: string): Promise<CustomRole | null> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.customRole.findFirst({ where: { id: roleId, tenantId: scope.tenantId } }),
    );
  }

  async listCustomRoles(scope: TenantScope): Promise<CustomRole[]> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.customRole.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { displayName: 'asc' },
      }),
    );
  }

  async updateCustomRole(
    scope: TenantScope,
    roleId: string,
    input: Partial<{
      displayName: string;
      description: string;
      permissions: Record<string, string[]>;
      maxScope: string;
      enabled: boolean;
    }>,
  ): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.customRole.updateMany({
        where: { id: roleId, tenantId: scope.tenantId },
        // Cast on the whole object rather than spreading a `never`: `maxScope` is a Prisma enum
        // and `permissions` is JSON, and neither narrows from the plain shape this method takes.
        data: { ...input, version: { increment: 1 } } as never,
      });
      return result.count;
    });
  }

  // ---- Role assignments ----

  async createAssignment(
    scope: TenantScope,
    input: {
      userId: string;
      roleKind: string;
      customRoleId?: string | undefined;
      scopeKind: string;
      departmentIds?: readonly string[] | undefined;
      selectedResourceIds?: readonly string[] | undefined;
      expiresAt?: Date | undefined;
      grantedByUserId?: string | undefined;
      justification?: string | undefined;
    },
  ): Promise<RoleAssignment> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.roleAssignment.create({
        data: {
          tenantId: scope.tenantId,
          userId: input.userId,
          roleKind: input.roleKind as never,
          ...(input.customRoleId === undefined ? {} : { customRoleId: input.customRoleId }),
          scopeKind: input.scopeKind as never,
          departmentIds: [...(input.departmentIds ?? [])],
          selectedResourceIds: [...(input.selectedResourceIds ?? [])],
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.grantedByUserId === undefined
            ? {}
            : { grantedByUserId: input.grantedByUserId }),
          ...(input.justification === undefined ? {} : { justification: input.justification }),
        },
      }),
    );
  }

  /**
   * Every live assignment for one person in one company, with any custom role attached.
   *
   * The hot path: this runs on every authorization decision. Expired assignments are filtered in
   * SQL rather than in the caller, so an expiry cannot be forgotten by a new call site — and they
   * are filtered rather than deleted, so the audit trail keeps "this person did have access,
   * until this date".
   */
  async listLiveAssignments(
    scope: TenantScope,
    userId: string,
    now = new Date(),
  ): Promise<(RoleAssignment & { customRole: CustomRole | null })[]> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.roleAssignment.findMany({
        where: {
          tenantId: scope.tenantId,
          userId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: { customRole: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async listAssignmentsForTenant(
    scope: TenantScope,
  ): Promise<(RoleAssignment & { customRole: CustomRole | null })[]> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.roleAssignment.findMany({
        where: { tenantId: scope.tenantId },
        include: { customRole: true },
        orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async findAssignment(scope: TenantScope, assignmentId: string) {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.roleAssignment.findFirst({
        where: { id: assignmentId, tenantId: scope.tenantId },
        include: { customRole: true },
      }),
    );
  }

  async deleteAssignment(scope: TenantScope, assignmentId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.roleAssignment.deleteMany({
        where: { id: assignmentId, tenantId: scope.tenantId },
      });
      return result.count;
    });
  }

  // ---- Policy rules ----

  async createPolicyRule(
    scope: TenantScope,
    input: {
      layer: string;
      departmentId?: string | undefined;
      objectiveId?: string | undefined;
      engineAgentId?: string | undefined;
      module?: string | undefined;
      action?: string | undefined;
      effect: string;
      mandatory: boolean;
      maxScope?: string | undefined;
      reason: string;
      createdByUserId?: string | undefined;
    },
  ): Promise<PolicyRule> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.policyRule.create({
        data: {
          tenantId: scope.tenantId,
          layer: input.layer as never,
          ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
          ...(input.objectiveId === undefined ? {} : { objectiveId: input.objectiveId }),
          ...(input.engineAgentId === undefined ? {} : { engineAgentId: input.engineAgentId }),
          ...(input.module === undefined ? {} : { module: input.module }),
          ...(input.action === undefined ? {} : { action: input.action }),
          effect: input.effect as never,
          mandatory: input.mandatory,
          ...(input.maxScope === undefined ? {} : { maxScope: input.maxScope as never }),
          reason: input.reason,
          ...(input.createdByUserId === undefined
            ? {}
            : { createdByUserId: input.createdByUserId }),
        },
      }),
    );
  }

  /** Every enabled rule that belongs to one company. */
  async listPolicyRules(scope: TenantScope): Promise<PolicyRule[]> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.policyRule.findMany({
        where: { tenantId: scope.tenantId, enabled: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async deletePolicyRule(scope: TenantScope, ruleId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.policyRule.deleteMany({
        where: { id: ruleId, tenantId: scope.tenantId },
      });
      return result.count;
    });
  }

  /**
   * The Platform layer: rules with no tenant, which apply to every company.
   *
   * Platform-plane by definition, and it returns restrictions only — a company learns what it is
   * forbidden, never anything about another tenant.
   */
  async listPlatformPolicyRulesForPlatform(): Promise<PolicyRule[]> {
    return this.prisma.client.policyRule.findMany({
      where: { tenantId: null, layer: 'Platform', enabled: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ---- Separation of duties ----

  async createSodPolicy(
    scope: TenantScope,
    input: {
      layer: string;
      module?: string | undefined;
      action: string;
      rule: string;
      mandatory: boolean;
      reason: string;
    },
  ): Promise<SeparationOfDutiesPolicy> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.separationOfDutiesPolicy.create({
        data: {
          tenantId: scope.tenantId,
          layer: input.layer as never,
          ...(input.module === undefined ? {} : { module: input.module }),
          action: input.action,
          rule: input.rule as never,
          mandatory: input.mandatory,
          reason: input.reason,
        },
      }),
    );
  }

  async listSodPolicies(scope: TenantScope): Promise<SeparationOfDutiesPolicy[]> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.separationOfDutiesPolicy.findMany({
        where: { tenantId: scope.tenantId, enabled: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async deleteSodPolicy(scope: TenantScope, policyId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.separationOfDutiesPolicy.deleteMany({
        where: { id: policyId, tenantId: scope.tenantId },
      });
      return result.count;
    });
  }

  /** The platform baseline every company inherits, including the seeded no-self-approval rule. */
  async listPlatformSodPoliciesForPlatform(): Promise<SeparationOfDutiesPolicy[]> {
    return this.prisma.client.separationOfDutiesPolicy.findMany({
      where: { tenantId: null, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ---- TCSiON mappings ----

  async upsertTcsionMapping(
    scope: TenantScope,
    input: {
      externalUserType: string;
      externalAllotment: string | null;
      ubossUserType: string;
      roleKind: string;
      customRoleId?: string | undefined;
      scopeKind: string;
      departmentIds?: readonly string[] | undefined;
      moduleVisibility: Record<string, boolean>;
      allowedActions: Record<string, string[]>;
      approvedReference: string;
    },
  ): Promise<TcsionMapping> {
    const data = {
      ubossUserType: input.ubossUserType as never,
      roleKind: input.roleKind as never,
      ...(input.customRoleId === undefined ? {} : { customRoleId: input.customRoleId }),
      scopeKind: input.scopeKind as never,
      departmentIds: [...(input.departmentIds ?? [])],
      moduleVisibility: input.moduleVisibility,
      allowedActions: input.allowedActions,
      approvedReference: input.approvedReference,
    };

    /**
     * Find-then-write rather than `upsert`.
     *
     * The unique key is `(tenant_id, external_user_type, external_allotment)` and the last member
     * is **nullable** — a mapping by user type alone has no allotment. Prisma's `upsert` cannot
     * target a compound unique containing a NULL, so the obvious version fails at runtime for
     * exactly the common case. PostgreSQL's own unique index treats NULLs as distinct too, which
     * is why the constraint permits one row per user type as intended.
     *
     * Both statements run inside one tenant transaction, so a concurrent load of the same mapping
     * cannot interleave between the read and the write.
     */
    return this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.tcsionMapping.findFirst({
        where: {
          tenantId: scope.tenantId,
          externalUserType: input.externalUserType,
          externalAllotment: input.externalAllotment,
        },
      });

      if (existing) {
        return this.prisma.client.tcsionMapping.update({
          where: { id: existing.id },
          data: { ...data, version: { increment: 1 } },
        });
      }

      return this.prisma.client.tcsionMapping.create({
        data: {
          tenantId: scope.tenantId,
          externalUserType: input.externalUserType,
          externalAllotment: input.externalAllotment,
          ...data,
        },
      });
    });
  }

  async listTcsionMappings(scope: TenantScope): Promise<TcsionMapping[]> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.tcsionMapping.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: [{ externalUserType: 'asc' }, { externalAllotment: 'asc' }],
      }),
    );
  }

  async findTcsionMapping(
    scope: TenantScope,
    externalUserType: string,
    externalAllotment: string | null,
  ): Promise<TcsionMapping | null> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.tcsionMapping.findFirst({
        where: {
          tenantId: scope.tenantId,
          externalUserType,
          externalAllotment,
          enabled: true,
        },
      }),
    );
  }

  async deleteTcsionMapping(scope: TenantScope, mappingId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.tcsionMapping.deleteMany({
        where: { id: mappingId, tenantId: scope.tenantId },
      });
      return result.count;
    });
  }

  // ---- Membership user type ----

  /** The person's user type inside this company, and how they were provisioned. */
  async findMembershipUserType(
    scope: TenantScope,
    userId: string,
  ): Promise<{
    userType: string;
    accountState: string;
    externalUserType: string | null;
    externalAllotment: string | null;
  } | null> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: scope.tenantId, userId },
        select: {
          userType: true,
          accountState: true,
          externalUserType: true,
          externalAllotment: true,
        },
      }),
    );
  }

  async setMembershipUserType(
    scope: TenantScope,
    userId: string,
    input: {
      userType: string;
      externalUserType?: string | null;
      externalAllotment?: string | null;
    },
  ): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.tenantMembership.updateMany({
        where: { tenantId: scope.tenantId, userId },
        data: {
          userType: input.userType as never,
          ...(input.externalUserType === undefined
            ? {}
            : { externalUserType: input.externalUserType }),
          ...(input.externalAllotment === undefined
            ? {}
            : { externalAllotment: input.externalAllotment }),
          version: { increment: 1 },
        },
      });
      return result.count;
    });
  }
}
